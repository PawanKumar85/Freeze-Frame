"""Lightweight thread-safe SQLite store for alerts, session events, and frame+telemetry metrics."""

import csv
import io
import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

_DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "freeze_logs.db"


class AlertLogStore:
    """Zero-dependency SQLite event + metric log store using WAL mode."""

    def __init__(
        self,
        db_path: Optional[str] = None,
        max_alert_rows: int = 0,
        max_metric_rows: int = 0,
    ) -> None:
        self._path = Path(db_path or os.getenv("LOG_DB_PATH") or _DEFAULT_DB_PATH)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._max_alert_rows = max_alert_rows
        self._max_metric_rows = max_metric_rows
        self._alert_inserts = 0
        self._metric_inserts = 0
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self._path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS alert_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    event TEXT NOT NULL,
                    pts_sec REAL,
                    static_zones TEXT,
                    freeze_ratio REAL,
                    detail TEXT NOT NULL,
                    payload_json TEXT NOT NULL
                )
                """
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_alert_logs_channel ON alert_logs(channel_id, id DESC)"
            )
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS metric_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at TEXT NOT NULL,
                    channel_id TEXT NOT NULL,
                    stream_state TEXT NOT NULL,
                    pts_sec REAL,
                    static_zones TEXT,
                    freeze_ratio REAL,
                    cpu_pct REAL,
                    ram_mb REAL,
                    rx_mbps REAL,
                    tx_kbps REAL,
                    hls_live_delay_sec REAL
                )
                """
            )
            self._conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_metric_logs_channel ON metric_logs(channel_id, id DESC)"
            )
            self._conn.commit()

    @staticmethod
    def _format_detail(event: str, payload: dict) -> str:
        if event == "ERROR":
            return str(payload.get("message") or "Stream error")
        if event == "STARTED":
            return f"{payload.get('sample_fps', '—')} FPS · Grid {payload.get('grid_size', 3)}×{payload.get('grid_size', 3)} · Eco {payload.get('eco_mode', False)}"
        if event == "STOPPED":
            return "Monitoring stopped"
        if event == "SEGMENT_DELAY":
            gap = f"{payload['frame_gap_sec']}s gap" if payload.get("frame_gap_sec") is not None else "stalled"
            hls_delay = f" · HLS delay {payload['hls_live_delay_sec']}s" if payload.get("hls_live_delay_sec") is not None else ""
            target = f" · target {payload['target_duration_sec']}s" if payload.get("target_duration_sec") is not None else ""
            return f"{gap}{hls_delay}{target}"
        if event == "SEGMENT_DELAY_RECOVERED":
            return f"HLS delay {payload['hls_live_delay_sec']}s" if payload.get("hls_live_delay_sec") is not None else "segments resumed"
        pts = payload.get("pts_sec")
        pts_str = f"{float(pts):.2f}s" if pts is not None else "—"
        zones = payload.get("static_zones", "—")
        ratio = payload.get("freeze_ratio")
        ratio_str = str(ratio) if ratio is not None else "—"
        return f"PTS {pts_str} · zones {zones} · ratio {ratio_str}"

    def append(self, event_name: str, payload: dict) -> None:
        event = "ERROR" if event_name == "error_msg" else str(payload.get("event") or event_name)
        channel_id = str(payload.get("channel_id") or "")
        pts_sec = payload.get("pts_sec")
        static_zones = str(payload.get("static_zones")) if payload.get("static_zones") is not None else None
        freeze_ratio = payload.get("freeze_ratio")
        detail = self._format_detail(event, payload)
        created_at = datetime.now(timezone.utc).isoformat()
        payload_json = json.dumps(payload)

        with self._lock:
            self._conn.execute(
                """
                INSERT INTO alert_logs (
                    created_at, channel_id, event, pts_sec, static_zones, freeze_ratio, detail, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (created_at, channel_id, event, pts_sec, static_zones, freeze_ratio, detail, payload_json),
            )
            self._alert_inserts += 1
            if self._max_alert_rows > 0 and self._alert_inserts % 50 == 0:
                self._conn.execute(
                    "DELETE FROM alert_logs WHERE id <= (SELECT MAX(id) - ? FROM alert_logs)",
                    (self._max_alert_rows,),
                )
            self._conn.commit()

    def append_metric(
        self,
        frame_payload: dict,
        sys_stats: dict,
        hls_live_delay_sec: Optional[float] = None,
    ) -> None:
        created_at = datetime.now(timezone.utc).isoformat()
        channel_id = str(frame_payload.get("channel_id") or "")
        stream_state = "FROZEN" if frame_payload.get("is_frozen") else "NORMAL"
        pts_sec = frame_payload.get("pts_sec")
        static_zones = str(frame_payload.get("static_zones") or "—")
        freeze_ratio = frame_payload.get("freeze_ratio")

        with self._lock:
            self._conn.execute(
                """
                INSERT INTO metric_logs (
                    created_at, channel_id, stream_state, pts_sec, static_zones, freeze_ratio,
                    cpu_pct, ram_mb, rx_mbps, tx_kbps, hls_live_delay_sec
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    created_at,
                    channel_id,
                    stream_state,
                    pts_sec,
                    static_zones,
                    freeze_ratio,
                    sys_stats.get("cpu_pct"),
                    sys_stats.get("ram_mb"),
                    sys_stats.get("rx_mbps"),
                    sys_stats.get("tx_kbps"),
                    hls_live_delay_sec,
                ),
            )
            self._metric_inserts += 1
            if self._max_metric_rows > 0 and self._metric_inserts % 100 == 0:
                self._conn.execute(
                    "DELETE FROM metric_logs WHERE id <= (SELECT MAX(id) - ? FROM metric_logs)",
                    (self._max_metric_rows,),
                )
            self._conn.commit()

    def recent(self, limit: int = 100, channel_id: Optional[str] = None) -> list[dict]:
        safe_limit = max(1, min(int(limit), 500))
        with self._lock:
            if channel_id:
                rows = self._conn.execute(
                    """
                    SELECT id, created_at, channel_id, event, pts_sec, static_zones, freeze_ratio, detail
                    FROM alert_logs
                    WHERE channel_id = ?
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (channel_id, safe_limit),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    """
                    SELECT id, created_at, channel_id, event, pts_sec, static_zones, freeze_ratio, detail
                    FROM alert_logs
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (safe_limit,),
                ).fetchall()

        return [dict(r) for r in rows]

    def recent_metrics(self, limit: int = 200, channel_id: Optional[str] = None) -> list[dict]:
        safe_limit = max(1, min(int(limit), 5000))
        with self._lock:
            if channel_id:
                rows = self._conn.execute(
                    """
                    SELECT id, created_at, channel_id, stream_state, pts_sec, static_zones, freeze_ratio,
                           cpu_pct, ram_mb, rx_mbps, tx_kbps, hls_live_delay_sec
                    FROM metric_logs
                    WHERE channel_id = ?
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (channel_id, safe_limit),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    """
                    SELECT id, created_at, channel_id, stream_state, pts_sec, static_zones, freeze_ratio,
                           cpu_pct, ram_mb, rx_mbps, tx_kbps, hls_live_delay_sec
                    FROM metric_logs
                    ORDER BY id DESC
                    LIMIT ?
                    """,
                    (safe_limit,),
                ).fetchall()
        return [dict(r) for r in rows]

    def export_metrics_csv(self, limit: int = 5000, channel_id: Optional[str] = None) -> str:
        rows = self.recent_metrics(limit=limit, channel_id=channel_id)
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "id",
            "created_at",
            "channel_id",
            "stream_state",
            "pts_sec",
            "static_zones",
            "freeze_ratio",
            "cpu_pct",
            "ram_mb",
            "rx_mbps",
            "tx_kbps",
            "hls_live_delay_sec",
        ])
        for r in rows:
            writer.writerow([
                r["id"],
                r["created_at"],
                r["channel_id"],
                r["stream_state"],
                r["pts_sec"],
                r["static_zones"],
                r["freeze_ratio"],
                r["cpu_pct"],
                r["ram_mb"],
                r["rx_mbps"],
                r["tx_kbps"],
                r["hls_live_delay_sec"],
            ])
        return buf.getvalue()

    def clear(self) -> int:
        with self._lock:
            c1 = self._conn.execute("DELETE FROM alert_logs").rowcount
            c2 = self._conn.execute("DELETE FROM metric_logs").rowcount
            self._conn.commit()
            return c1 + c2

    def close(self) -> None:
        with self._lock:
            self._conn.close()
