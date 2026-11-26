import asyncio
import json
import os
import queue
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse
import uvicorn

from detector import AlertBroadcaster, FreezeStateMachine, NativeMonitorRunner
from detector.hls_metadata import fetch_hls_metadata, resolve_lowest_variant_url
from detector.log_store import AlertLogStore
from models import StateMachineConfig, StreamExtractConfig, ZoneMetricConfig

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
FRONTEND_PATH = FRONTEND_DIST / "index.html"

# Pre-read index.html bytes once at startup — avoids disk I/O on every page load.
_INDEX_HTML_BYTES: bytes = b""
_INDEX_HTML_HEADERS = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
}


def _load_index_html() -> None:
    global _INDEX_HTML_BYTES
    if FRONTEND_PATH.exists():
        _INDEX_HTML_BYTES = FRONTEND_PATH.read_bytes()


class SseBroadcaster:
    """Thread-safe SSE broadcaster implementing AlertBroadcaster protocol.

    Optimizations vs. original:
    - Uses asyncio.Event to wake SSE coroutines instead of polling asyncio.to_thread.
    - Keeps a per-subscriber asyncio.Queue (not threading.Queue) so the event loop
      reads directly without spawning a thread per message.
    - Lock is only held briefly to snapshot the subscriber set; actual puts are
      outside the lock to avoid contention.
    """

    def __init__(self, log_store: Optional[AlertLogStore] = None) -> None:
        self._lock = threading.Lock()
        # {asyncio.Queue: asyncio.AbstractEventLoop}  — one entry per SSE client
        self._subscribers: dict["asyncio.Queue[tuple[str, str]]", asyncio.AbstractEventLoop] = {}
        self._last_frame: Optional[dict] = None
        self._log_store = log_store

    def subscribe(self, loop: asyncio.AbstractEventLoop) -> "asyncio.Queue[tuple[str, str]]":
        """Register a new SSE client.  Returns an asyncio.Queue for (event, json_str)."""
        q: asyncio.Queue[tuple[str, str]] = asyncio.Queue(maxsize=200)
        with self._lock:
            self._subscribers[q] = loop
            last_frame = self._last_frame
        if last_frame is not None:
            try:
                loop.call_soon_threadsafe(q.put_nowait, ("frame", json.dumps(last_frame)))
            except Exception:
                pass
        return q

    def unsubscribe(self, q: "asyncio.Queue[tuple[str, str]]") -> None:
        with self._lock:
            self._subscribers.pop(q, None)

    def has_subscribers(self) -> bool:
        with self._lock:
            return len(self._subscribers) > 0

    def publish(self, event_name: str, payload: dict) -> None:
        if self._log_store is not None:
            try:
                if event_name in ("alert", "error_msg"):
                    self._log_store.append(event_name, payload)
                elif event_name == "frame":
                    self._log_store.append_metric(
                        payload,
                        SYS_SAMPLER.latest(),
                        MANAGER.hls_live_delay_sec(),
                    )
            except Exception:
                pass

        with self._lock:
            if event_name == "frame":
                self._last_frame = payload
            elif event_name == "status" and not payload.get("running"):
                self._last_frame = None
            subs = list(self._subscribers.items())

        if not subs:
            return

        # Serialise once — reused for every connected subscriber.
        data = json.dumps(payload)

        for q, loop in subs:
            try:
                # Put from a Rust/Python thread into the asyncio queue safely.
                loop.call_soon_threadsafe(q.put_nowait, (event_name, data))
            except Exception:
                # Queue full: drop frame silently; for alerts/status evict oldest.
                if event_name in ("alert", "status", "error_msg"):
                    try:
                        loop.call_soon_threadsafe(q.get_nowait)
                        loop.call_soon_threadsafe(q.put_nowait, (event_name, data))
                    except Exception:
                        pass


class MonitorManager:
    """Manages a single continuous HLS monitoring session."""

    def __init__(self, broadcaster: AlertBroadcaster) -> None:
        self._lock = threading.Lock()
        self._op_lock = threading.Lock()
        self._broadcaster = broadcaster
        self._thread: Optional[threading.Thread] = None
        self._runner: Optional[NativeMonitorRunner] = None
        self._running = False
        self._channel_id = ""
        self._hls_url = ""
        self._sample_fps = 1.0
        self._alert_after_sec = 10.0
        self._roi_x = 0.0
        self._roi_y = 0.0
        self._roi_width = 1.0
        self._roi_height = 1.0
        self._grid_size = 3
        self._eco_mode = False
        self._decode_mode = "auto"
        self._active_decoder = ""
        self._last_frame_at = 0.0
        self._last_pts = 0.0
        self._segment_delayed = False
        self._hls_meta: dict = {}

    def status(self) -> dict:
        with self._lock:
            return {
                "running": self._running,
                "channel_id": self._channel_id,
                "hls_url": self._hls_url,
                "sample_fps": self._sample_fps,
                "alert_after_sec": self._alert_after_sec,
                "roi_x": self._roi_x,
                "roi_y": self._roi_y,
                "roi_width": self._roi_width,
                "roi_height": self._roi_height,
                "grid_size": self._grid_size,
                "eco_mode": self._eco_mode,
                "decode_mode": self._decode_mode,
                "active_decoder": self._active_decoder,
                "hls_meta": self._hls_meta,
            }

    def hls_live_delay_sec(self) -> Optional[float]:
        with self._lock:
            return self._hls_meta.get("hls_live_delay_sec")

    def start(
        self,
        hls_url: str,
        channel_id: str,
        sample_fps: float,
        roi_x: float = 0.0,
        roi_y: float = 0.0,
        roi_width: float = 1.0,
        roi_height: float = 1.0,
        alert_after_sec: float = 10.0,
        grid_size: int = 3,
        eco_mode: bool = False,
        decode_mode: str = "auto",
    ) -> dict:
        with self._op_lock:
            self._stop_locked(publish_status=False)

            grid = grid_size if grid_size in (2, 3, 4, 5) else 3
            freeze_ratio = {2: 0.90, 3: 0.95, 4: 0.93, 5: 0.92}[grid]
            effective_url = resolve_lowest_variant_url(hls_url)
            effective_fps = min(sample_fps, 1.0) if eco_mode else sample_fps
            proc_w, proc_h = (160, 90) if eco_mode else (240, 135)

            ext_cfg = StreamExtractConfig(
                hls_url=effective_url,
                sample_fps=effective_fps,
                proc_width=proc_w,
                proc_height=proc_h,
                eco_mode=eco_mode,
                decode_mode=decode_mode,
                roi_x=roi_x,
                roi_y=roi_y,
                roi_width=roi_width,
                roi_height=roi_height,
            )
            met_cfg = ZoneMetricConfig(
                proc_width=ext_cfg.proc_width,
                proc_height=ext_cfg.proc_height,
                grid_rows=grid,
                grid_cols=grid,
                freeze_ratio=freeze_ratio,
            )
            sm = FreezeStateMachine(
                StateMachineConfig(
                    sample_fps=effective_fps,
                    freeze_confirmation_ms=max(100, int(round(alert_after_sec * 1000))),
                    max_pts_gap_sec=10.0 if eco_mode else 5.0,
                )
            )

            def handle_frame(payload: dict) -> None:
                recovered_info: Optional[dict] = None
                with self._lock:
                    self._last_frame_at = time.monotonic()
                    self._last_pts = payload.get("pts_sec", self._last_pts)
                    if payload.get("active_decoder"):
                        self._active_decoder = str(payload["active_decoder"])
                    if self._segment_delayed:
                        self._segment_delayed = False
                        recovered_info = {
                            "channel_id": channel_id,
                            "event": "SEGMENT_DELAY_RECOVERED",
                            "pts_sec": round(self._last_pts, 3),
                        }
                self._broadcaster.publish("frame", payload)
                if recovered_info is not None:
                    self._broadcaster.publish("alert", recovered_info)

            runner = NativeMonitorRunner(
                channel_id=channel_id,
                extract_cfg=ext_cfg,
                metric_cfg=met_cfg,
                state_machine=sm,
                on_event=lambda ev: self._broadcaster.publish("alert", ev),
                on_frame=handle_frame,
            )

            with self._lock:
                self._running = True
                self._channel_id = channel_id
                self._hls_url = hls_url
                self._sample_fps = sample_fps
                self._alert_after_sec = alert_after_sec
                self._roi_x = roi_x
                self._roi_y = roi_y
                self._roi_width = roi_width
                self._roi_height = roi_height
                self._grid_size = grid
                self._eco_mode = eco_mode
                self._decode_mode = decode_mode
                self._active_decoder = ""
                self._last_frame_at = time.monotonic()
                self._segment_delayed = False
                self._runner = runner

            st = self.status()
            self._broadcaster.publish("status", st)
            LOG_STORE.append("STARTED", {**st, "event": "STARTED"})

            # Segment watchdog — runs in its own daemon thread.
            watchdog = threading.Thread(
                target=self._segment_watchdog,
                args=(runner, channel_id, effective_url, sample_fps),
                daemon=True,
                name="segment-watchdog",
            )
            main_thread = threading.Thread(
                target=self._run_loop,
                args=(runner,),
                daemon=True,
                name="monitor-runner",
            )
            self._thread = main_thread
            main_thread.start()
            watchdog.start()

            return st

    def _segment_watchdog(
        self,
        runner: NativeMonitorRunner,
        channel_id: str,
        hls_url: str,
        sample_fps: float,
    ) -> None:
        """Poll HLS metadata and detect segment stalls asynchronously."""
        # Use an Event so we can exit cleanly when the runner stops.
        stop_event = threading.Event()

        POLL_INTERVAL = 6.0  # seconds between HLS playlist fetches
        WATCHDOG_TICK = 2.0  # seconds between frame-gap checks

        last_meta_time = 0.0
        last_seq: Optional[int] = None
        last_seq_at = time.monotonic()

        while True:
            # Exit if the runner has been replaced or stopped.
            with self._lock:
                is_current = self._runner is runner and self._running
            if not is_current:
                return

            now = time.monotonic()

            # -- HLS metadata fetch (every POLL_INTERVAL seconds) --
            if now - last_meta_time >= POLL_INTERVAL:
                last_meta_time = now
                try:
                    meta = fetch_hls_metadata(hls_url, timeout=4.0)
                    seq = meta.get("media_sequence")
                    if seq is not None and seq != last_seq:
                        last_seq = seq
                        last_seq_at = now
                    with self._lock:
                        if self._runner is runner:
                            self._hls_meta = meta
                except Exception:
                    pass

            # -- Frame-gap / segment-delay check (every WATCHDOG_TICK seconds) --
            with self._lock:
                last_pts = self._last_pts
                frame_gap = now - self._last_frame_at
                was_delayed = self._segment_delayed
                meta = self._hls_meta
                is_eco = self._eco_mode
                is_current = self._runner is runner

            if not is_current:
                return

            target_dur = meta.get("target_duration_sec") or 4.0
            if is_eco:
                # In Eco Mode, only fire SEGMENT_DELAY if BOTH playlist sequence and decoded frames stall.
                if last_seq is not None:
                    seq_gap = now - last_seq_at
                    delayed_now = seq_gap > max(20.0, target_dur * 2.5) and frame_gap > target_dur
                else:
                    delayed_now = frame_gap > max(30.0, target_dur * 3.5)
            else:
                delayed_now = frame_gap > max(10.0, target_dur * 2.0)

            if delayed_now and not was_delayed:
                with self._lock:
                    if self._runner is runner:
                        self._segment_delayed = True
                self._broadcaster.publish(
                    "alert",
                    {
                        "channel_id": channel_id,
                        "event": "SEGMENT_DELAY",
                        "pts_sec": round(last_pts, 3),
                        "static_zones": "—",
                        "freeze_ratio": 0.0,
                        "frame_gap_sec": round(frame_gap, 1),
                        **meta,
                    },
                )

            stop_event.wait(timeout=WATCHDOG_TICK)

    def _run_loop(self, runner: NativeMonitorRunner) -> None:
        try:
            runner.run()
        except Exception as exc:
            with self._lock:
                is_current = self._runner is runner
            if is_current:
                self._broadcaster.publish("error_msg", {"message": str(exc)})
        finally:
            should_publish = False
            with self._lock:
                if self._runner is runner:
                    self._running = False
                    self._runner = None
                    self._active_decoder = ""
                    should_publish = True
            if should_publish:
                self._broadcaster.publish("status", self.status())

    def _stop_locked(self, publish_status: bool = True) -> dict:
        with self._lock:
            runner = self._runner
            thread = self._thread
            self._running = False
            self._runner = None
            self._thread = None
            self._active_decoder = ""

        if runner is not None:
            runner.close()
        if thread is not None and thread.is_alive():
            thread.join(timeout=3.0)

        st = self.status()
        if publish_status:
            self._broadcaster.publish("status", st)
            if st.get("channel_id"):
                LOG_STORE.append("STOPPED", {"channel_id": st["channel_id"], "event": "STOPPED"})
        return st

    def stop(self) -> dict:
        with self._op_lock:
            return self._stop_locked(publish_status=True)


class _SystemStatsSampler:
    """Zero-dependency Linux /proc sampler for container CPU %, RAM (MiB), and Net bandwidth."""

    def __init__(self) -> None:
        self._clk_tck = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
        self._prev_wall = time.monotonic()
        self._prev_proc_ticks = self._read_proc_ticks()
        self._prev_rx, self._prev_tx = self._read_net_bytes()
        self._last_sample: dict = {
            "cpu_pct": None,
            "ram_mb": self._read_ram_mb(),
            "rx_mbps": None,
            "tx_kbps": None,
        }

    def latest(self) -> dict:
        return self._last_sample

    @staticmethod
    def _read_proc_ticks() -> Optional[int]:
        try:
            raw = Path("/proc/self/stat").read_text()
            rparen = raw.rfind(")")
            if rparen == -1:
                return None
            fields = raw[rparen + 2 :].split()
            # utime (index 11 after ')') + stime (index 12)
            return int(fields[11]) + int(fields[12])
        except Exception:
            return None

    @staticmethod
    def _read_ram_mb() -> Optional[float]:
        try:
            for line in Path("/proc/self/status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    kb = int(line.split()[1])
                    return round(kb / 1024.0, 1)
        except Exception:
            pass
        return None

    @staticmethod
    def _read_net_bytes() -> tuple[Optional[int], Optional[int]]:
        try:
            rx_total = 0
            tx_total = 0
            for line in Path("/proc/net/dev").read_text().splitlines()[2:]:
                iface, rest = line.split(":", 1)
                if iface.strip() == "lo":
                    continue
                cols = rest.split()
                rx_total += int(cols[0])
                tx_total += int(cols[8])
            return rx_total, tx_total
        except Exception:
            return None, None

    def sample(self) -> dict:
        now = time.monotonic()
        dt = max(0.1, now - self._prev_wall)

        ticks = self._read_proc_ticks()
        cpu_pct: Optional[float] = None
        if ticks is not None and self._prev_proc_ticks is not None:
            delta_sec = max(0, ticks - self._prev_proc_ticks) / self._clk_tck
            cpu_pct = round((delta_sec / dt) * 100.0, 1)
        self._prev_proc_ticks = ticks

        rx, tx = self._read_net_bytes()
        rx_mbps: Optional[float] = None
        tx_kbps: Optional[float] = None
        if rx is not None and self._prev_rx is not None and tx is not None and self._prev_tx is not None:
            rx_mbps = round(((max(0, rx - self._prev_rx) * 8.0) / dt) / 1_000_000.0, 2)
            tx_kbps = round((max(0, tx - self._prev_tx) / dt) / 1024.0, 1)
        self._prev_rx, self._prev_tx = rx, tx
        self._prev_wall = now

        snap = {
            "cpu_pct": cpu_pct,
            "ram_mb": self._read_ram_mb(),
            "rx_mbps": rx_mbps,
            "tx_kbps": tx_kbps,
        }
        self._last_sample = snap
        return snap


LOG_STORE = AlertLogStore()
BROADCASTER = SseBroadcaster(log_store=LOG_STORE)
MANAGER = MonitorManager(BROADCASTER)
SYS_SAMPLER = _SystemStatsSampler()


class StartRequest(BaseModel):
    hls_url: str
    channel_id: str = "channel_001"
    sample_fps: float = Field(default=1.0, gt=0.0)
    alert_after_sec: float = Field(default=10.0, gt=0.0)
    grid_size: int = Field(default=3, ge=2, le=5)
    eco_mode: bool = False
    decode_mode: Literal["auto", "cpu", "gpu"] = "auto"
    roi_x: float = 0.0
    roi_y: float = 0.0
    roi_width: float = 1.0
    roi_height: float = 1.0


async def _stats_loop() -> None:
    while True:
        await asyncio.sleep(2.0)
        if BROADCASTER.has_subscribers():
            BROADCASTER.publish("sys_stats", SYS_SAMPLER.sample())


@asynccontextmanager
async def lifespan(_: FastAPI):
    _load_index_html()
    stats_task = asyncio.create_task(_stats_loop())
    try:
        yield
    finally:
        stats_task.cancel()
        MANAGER.stop()
        LOG_STORE.close()


app = FastAPI(title="HLS Freeze Monitor", lifespan=lifespan)


class _SelectiveGZipMiddleware(GZipMiddleware):
    """Compress JSON/CSV/JS/CSS responses while leaving SSE /api/events unbuffered."""

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("path") == "/api/events":
            await self.app(scope, receive, send)
            return
        await super().__call__(scope, receive, send)


app.add_middleware(_SelectiveGZipMiddleware, minimum_size=1000)


class _CachedStaticFiles(StaticFiles):
    """Serve hashed Vite assets with long-lived cache headers."""

    async def get_response(self, path: str, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


if (FRONTEND_DIST / "assets").is_dir():
    app.mount("/assets", _CachedStaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


@app.get("/")
@app.get("/hld")
@app.get("/history")
def index() -> Response:
    if _INDEX_HTML_BYTES:
        return Response(content=_INDEX_HTML_BYTES, headers=_INDEX_HTML_HEADERS)
    return FileResponse(FRONTEND_PATH, headers={"Cache-Control": "no-store"})


@app.get("/api/status")
def get_status() -> dict:
    return MANAGER.status()


@app.get("/api/logs")
def get_logs(limit: int = 100, channel_id: Optional[str] = None) -> dict:
    return {"logs": LOG_STORE.recent(limit=limit, channel_id=channel_id)}


@app.get("/api/metrics")
def get_metrics(limit: int = 200, channel_id: Optional[str] = None) -> dict:
    return {"metrics": LOG_STORE.recent_metrics(limit=limit, channel_id=channel_id)}


@app.get("/api/metrics/export")
def export_metrics(limit: int = 5000, channel_id: Optional[str] = None) -> Response:
    csv_data = LOG_STORE.export_metrics_csv(limit=limit, channel_id=channel_id)
    return Response(
        content=csv_data,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=freeze_metrics.csv"},
    )


@app.delete("/api/logs")
def clear_logs() -> dict:
    return {"deleted": LOG_STORE.clear()}


@app.post("/api/start")
def start_monitoring(req: StartRequest):
    hls_url = req.hls_url.strip()
    if not hls_url:
        return JSONResponse(status_code=400, content={"error": "hls_url is required"})
    channel_id = req.channel_id.strip() or "channel_001"
    try:
        return MANAGER.start(
            hls_url,
            channel_id,
            req.sample_fps,
            req.roi_x,
            req.roi_y,
            req.roi_width,
            req.roi_height,
            req.alert_after_sec,
            req.grid_size,
            req.eco_mode,
            req.decode_mode,
        )
    except Exception as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})


@app.post("/api/stop")
def stop_monitoring() -> dict:
    return MANAGER.stop()


@app.get("/api/events")
async def sse_events(request: Request) -> EventSourceResponse:
    async def event_generator():
        loop = asyncio.get_event_loop()
        q = BROADCASTER.subscribe(loop)
        try:
            # Send current status + system stats immediately on connect.
            yield {"event": "status", "data": json.dumps(MANAGER.status())}
            yield {"event": "sys_stats", "data": json.dumps(SYS_SAMPLER.sample())}
            while not await request.is_disconnected():
                try:
                    # asyncio.wait_for avoids blocking forever if no events arrive.
                    event_name, data = await asyncio.wait_for(q.get(), timeout=1.0)
                    yield {"event": event_name, "data": data}
                except asyncio.TimeoutError:
                    continue
        finally:
            BROADCASTER.unsubscribe(q)

    return EventSourceResponse(event_generator(), ping=15)


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    print(f"HLS Freeze Monitor UI running at http://{host}:{port}")
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="warning",
        loop="auto",           # uses uvloop if available, else asyncio
        http="auto",           # uses httptools if available
        timeout_keep_alive=30, # close idle HTTP/1.1 keep-alive connections sooner
    )
