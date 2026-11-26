import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import toast, { Toaster } from "react-hot-toast";
import { Rnd } from "react-rnd";
import { Activity, Bell01, Maximize02, Play, RefreshCw01, StopSquare } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";

const HldFlow = lazy(() => import("@/components/hld/HldFlow"));
const HistoryView = lazy(() => import("@/components/history/HistoryView"));

const DEFAULT_ROI = { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };

export default function App() {
  const [hlsUrl, setHlsUrl] = useState("");
  const [channelId, setChannelId] = useState("channel_001");
  const [sampleFps, setSampleFps] = useState("1.0");
  const [alertAfterSec, setAlertAfterSec] = useState("10");
  const [gridSize, setGridSize] = useState(3);
  const [ecoMode, setEcoMode] = useState(false);
  const [decodeMode, setDecodeMode] = useState("auto");
  const [activeDecoder, setActiveDecoder] = useState("");
  const [previewEnabled, setPreviewEnabled] = useState(true);
  const [roi, setRoi] = useState(DEFAULT_ROI);
  const [wrapSize, setWrapSize] = useState({ width: 960, height: 540 });

  const [isRunning, setIsRunning] = useState(false);
  const [badge, setBadge] = useState({ text: "IDLE", color: "gray" });
  const [streamInfo, setStreamInfo] = useState("Not started");
  const [previewNote, setPreviewNote] = useState("Waiting for stream");

  const [frameState, setFrameState] = useState({
    state: "—",
    pts: "—",
    zones: "—",
    ratio: "—",
    pct: 0,
    isStatic: false,
    isFrozen: null,
    zoneStates: [],
  });
  const [sysStats, setSysStats] = useState({
    cpu_pct: null,
    ram_mb: null,
    rx_mbps: null,
    tx_kbps: null,
  });
  const [logs, setLogs] = useState([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeTab, setActiveTab] = useState(() => {
    const p = window.location.pathname;
    if (p === "/hld" || new URLSearchParams(window.location.search).get("tab") === "hld") return "hld";
    if (p === "/history") return "history";
    return "monitor";
  });

  function switchTab(next) {
    setActiveTab(next);
    const path = next === "hld" ? "/hld" : next === "history" ? "/history" : "/";
    window.history.replaceState(null, "", path);
  }

  const videoRef = useRef(null);
  const previewWrapRef = useRef(null);
  const notifRef = useRef(null);
  const notifOpenRef = useRef(false);
  const hlsRef = useRef(null);
  const activePreviewUrlRef = useRef("");
  const roiRef = useRef(DEFAULT_ROI);
  const gridSizeRef = useRef(3);
  const ecoModeRef = useRef(false);
  const decodeModeRef = useRef("auto");
  const previewEnabledRef = useRef(true);
  const isRunningRef = useRef(false);
  const restartTimerRef = useRef(null);

  useEffect(() => {
    roiRef.current = roi;
  }, [roi]);

  useEffect(() => {
    gridSizeRef.current = gridSize;
  }, [gridSize]);

  useEffect(() => {
    ecoModeRef.current = ecoMode;
  }, [ecoMode]);

  useEffect(() => {
    decodeModeRef.current = decodeMode;
  }, [decodeMode]);

  useEffect(() => {
    previewEnabledRef.current = previewEnabled;
  }, [previewEnabled]);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  useEffect(() => {
    notifOpenRef.current = notifOpen;
  }, [notifOpen]);

  useEffect(() => {
    function handleOutside(e) {
      if (notifRef.current && !notifRef.current.contains(e.target)) {
        setNotifOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  useEffect(() => {
    const el = previewWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setWrapSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function addLog(label, detail, tone = "text-slate-700") {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [{ id: `${Date.now()}-${Math.random()}`, time, label, detail, tone }, ...prev].slice(0, 100));
    if (!notifOpenRef.current) {
      setUnreadCount((c) => c + 1);
    }
  }

  function stopPreview() {
    activePreviewUrlRef.current = "";
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    setPreviewNote("Stopped");
  }

  function startPreview(url) {
    if (!url || activePreviewUrlRef.current === url) return;
    stopPreview();
    activePreviewUrlRef.current = url;
    setPreviewNote("Playing preview");

    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      let networkRetries = 0;
      const player = new Hls({
        lowLatencyMode: false,
        startFragPrefetch: true,
        startLevel: 0,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 6,
        maxBufferLength: 20,
        maxMaxBufferLength: 40,
        backBufferLength: 20,
        fragLoadingTimeOut: 20000,
        manifestLoadingTimeOut: 15000,
        fragLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 6,
      });
      hlsRef.current = player;
      player.loadSource(url);
      player.attachMedia(video);
      player.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
      player.on(Hls.Events.FRAG_LOADED, () => {
        networkRetries = 0;
      });
      player.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (networkRetries < 5) {
            networkRetries += 1;
            setPreviewNote(`Reconnecting preview (${networkRetries}/5)...`);
            setTimeout(() => {
              if (hlsRef.current === player) player.startLoad();
            }, 1000 * networkRetries);
          } else {
            setPreviewNote("Preview disconnected (stream may still be monitored)");
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          player.recoverMediaError();
        } else {
          setPreviewNote("Preview error (stream may still be monitored)");
        }
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.play().catch(() => {});
    } else {
      setPreviewNote("HLS playback unsupported in this browser");
    }
  }

  async function restartIfRunning(
    nextRoi = roiRef.current,
    nextFps = sampleFps,
    nextAlert = alertAfterSec,
    nextGrid = gridSizeRef.current,
    nextEco = ecoModeRef.current,
    nextDecode = decodeModeRef.current
  ) {
    if (!isRunningRef.current || !hlsUrl.trim()) return;
    await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hls_url: hlsUrl.trim(),
        channel_id: channelId.trim() || "channel_001",
        sample_fps: Number(nextFps) || 1.0,
        alert_after_sec: Number(nextAlert) || 10.0,
        grid_size: [2, 3, 4, 5].includes(nextGrid) ? nextGrid : 3,
        eco_mode: Boolean(nextEco),
        decode_mode: ["auto", "cpu", "gpu"].includes(nextDecode) ? nextDecode : "auto",
        roi_x: Number(nextRoi.x.toFixed(4)),
        roi_y: Number(nextRoi.y.toFixed(4)),
        roi_width: Number(nextRoi.w.toFixed(4)),
        roi_height: Number(nextRoi.h.toFixed(4)),
      }),
    });
  }

  function scheduleRestart(
    nextFps = sampleFps,
    nextAlert = alertAfterSec,
    nextGrid = gridSizeRef.current,
    nextEco = ecoModeRef.current,
    nextRoi = roiRef.current,
    nextDecode = decodeModeRef.current
  ) {
    if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      restartIfRunning(nextRoi, nextFps, nextAlert, nextGrid, nextEco, nextDecode);
    }, 400);
  }

  function applyStatus(data) {
    const running = Boolean(data.running);
    setIsRunning(running);
    if (typeof data.sample_fps === "number") setSampleFps(String(data.sample_fps));
    if (typeof data.alert_after_sec === "number") setAlertAfterSec(String(data.alert_after_sec));
    if ([2, 3, 4, 5].includes(data.grid_size)) setGridSize(data.grid_size);
    if (typeof data.eco_mode === "boolean") setEcoMode(data.eco_mode);
    if (["auto", "cpu", "gpu"].includes(data.decode_mode)) setDecodeMode(data.decode_mode);
    if (typeof data.active_decoder === "string") setActiveDecoder(data.active_decoder);
    if (typeof data.roi_x === "number") {
      setRoi({ x: data.roi_x, y: data.roi_y, w: data.roi_width, h: data.roi_height });
    }
    if (!running) {
      setBadge({ text: "IDLE", color: "gray" });
      setActiveDecoder("");
      setFrameState((prev) => ({ ...prev, isFrozen: null, isStatic: false, zoneStates: [] }));
      stopPreview();
    } else {
      setBadge({ text: "MONITORING", color: "brand" });
      setStreamInfo(`${data.channel_id} · ${data.hls_url}`);
      setHlsUrl((prev) => prev || data.hls_url);
      if (previewEnabledRef.current) startPreview(data.hls_url);
    }
  }

  useEffect(() => {
    fetch("/api/status").then((r) => r.json()).then(applyStatus).catch(() => {});
    fetch("/api/logs?limit=100")
      .then((r) => r.json())
      .then((data) => {
        if (!Array.isArray(data.logs)) return;
        const toneFor = (ev) => {
          if (ev === "FREEZE_DETECTED") return "text-red-600 font-semibold";
          if (ev === "FREEZE_RECOVERED" || ev === "SEGMENT_DELAY_RECOVERED" || ev === "SEGMENT_DOWNLOAD_RECOVERED") {
            return "text-emerald-700 font-semibold";
          }
          if (ev === "SEGMENT_DELAY" || ev === "SEGMENT_DOWNLOAD_TIMEOUT" || ev === "ERROR") {
            return "text-amber-700 font-semibold";
          }
          return "text-slate-700";
        };
        setLogs(
          data.logs.map((row) => ({
            id: `db-${row.id}`,
            time: new Date(row.created_at).toLocaleTimeString(),
            label: row.channel_id ? `${row.event} (${row.channel_id})` : row.event,
            detail: row.detail,
            tone: toneFor(row.event),
          }))
        );
      })
      .catch(() => {});

    const evtSource = new EventSource("/api/events");
    evtSource.addEventListener("status", (e) => applyStatus(JSON.parse(e.data)));

    evtSource.addEventListener("sys_stats", (e) => {
      setSysStats(JSON.parse(e.data));
    });

    evtSource.addEventListener("frame", (e) => {
      const d = JSON.parse(e.data);
      if (d.active_decoder) setActiveDecoder(d.active_decoder);
      const frozen = Boolean(d.is_frozen);
      const nextText = frozen ? "FROZEN" : "NORMAL";
      setBadge((prev) =>
        prev.text === nextText ? prev : frozen ? { text: "FROZEN", color: "error" } : { text: "NORMAL", color: "success" }
      );
      setFrameState({
        state: frozen ? "FROZEN" : "NORMAL",
        pts: Number(d.pts_sec).toFixed(2),
        zones: d.static_zones,
        ratio: Number(d.freeze_ratio).toFixed(2),
        pct: Math.min(100, Math.max(0, d.freeze_ratio * 100)),
        isStatic: Boolean(d.is_static_frame),
        isFrozen: frozen,
        zoneStates: Array.isArray(d.zone_states) ? d.zone_states : [],
      });
    });

    evtSource.addEventListener("alert", (e) => {
      const d = JSON.parse(e.data);
      const detail = `PTS ${Number(d.pts_sec).toFixed(2)}s · zones ${d.static_zones} · ratio ${d.freeze_ratio}`;
      if (d.event === "FREEZE_DETECTED") {
        toast.error(`FREEZE DETECTED (${d.channel_id}) · ${d.static_zones} zones`, { id: "freeze-alert" });
        addLog(`${d.event} (${d.channel_id})`, detail, "text-red-600 font-semibold");
      } else if (d.event === "FREEZE_RECOVERED") {
        toast.success(`FREEZE RECOVERED (${d.channel_id})`, { id: "freeze-alert" });
        addLog(`${d.event} (${d.channel_id})`, detail, "text-emerald-700 font-semibold");
      } else if (d.event === "SEGMENT_DELAY") {
        const gap = d.frame_gap_sec != null ? `${d.frame_gap_sec}s gap` : "stalled";
        const hlsDelay = d.hls_live_delay_sec != null ? ` · HLS delay ${d.hls_live_delay_sec}s` : "";
        const target = d.target_duration_sec != null ? ` · target ${d.target_duration_sec}s` : "";
        setBadge({ text: "DELAYED", color: "warning" });
        toast.error(`SEGMENT DELAY (${d.channel_id}) · ${gap}${hlsDelay}`, { id: "segment-delay" });
        addLog(`${d.event} (${d.channel_id})`, `${gap}${hlsDelay}${target}`, "text-amber-700 font-semibold");
      } else if (d.event === "SEGMENT_DELAY_RECOVERED") {
        const hlsDelay = d.hls_live_delay_sec != null ? `HLS delay ${d.hls_live_delay_sec}s` : "segments resumed";
        toast.success(`SEGMENT RECOVERED (${d.channel_id})`, { id: "segment-delay" });
        addLog(`${d.event} (${d.channel_id})`, hlsDelay, "text-emerald-700 font-semibold");
      } else if (d.event === "SEGMENT_DOWNLOAD_TIMEOUT") {
        const t = d.timeout_sec != null ? `${d.timeout_sec}s timeout` : "download timeout";
        const segName = d.segment_url ? d.segment_url.split("/").pop() : "playlist";
        setBadge({ text: "TIMEOUT", color: "warning" });
        toast.error(`SEGMENT DOWNLOAD TIMEOUT (${d.channel_id}) · ${t}`, { id: "segment-timeout" });
        addLog(`${d.event} (${d.channel_id})`, `${t} (${segName})`, "text-amber-700 font-semibold");
      } else if (d.event === "SEGMENT_DOWNLOAD_RECOVERED") {
        toast.success(`SEGMENT DOWNLOAD RECOVERED (${d.channel_id})`, { id: "segment-timeout" });
        addLog(`${d.event} (${d.channel_id})`, "segment download resumed", "text-emerald-700 font-semibold");
      } else {
        addLog(`${d.event} (${d.channel_id})`, detail);
      }
    });

    evtSource.addEventListener("error_msg", (e) => {
      const d = JSON.parse(e.data);
      setBadge({ text: "ERROR", color: "warning" });
      toast.error(d.message || "Stream error");
      addLog("ERROR", d.message, "text-amber-700 font-semibold");
    });

    return () => {
      evtSource.close();
      stopPreview();
    };
  }, []);

  async function handleStart(e) {
    e.preventDefault();
    setFrameState((prev) => ({ ...prev, state: "Connecting...", isFrozen: null, zoneStates: [] }));
    const res = await fetch("/api/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hls_url: hlsUrl.trim(),
        channel_id: channelId.trim() || "channel_001",
        sample_fps: Number(sampleFps) || 1.0,
        alert_after_sec: Number(alertAfterSec) || 10.0,
        grid_size: [2, 3, 4, 5].includes(gridSize) ? gridSize : 3,
        eco_mode: Boolean(ecoMode),
        decode_mode: decodeMode,
        roi_x: Number(roi.x.toFixed(4)),
        roi_y: Number(roi.y.toFixed(4)),
        roi_width: Number(roi.w.toFixed(4)),
        roi_height: Number(roi.h.toFixed(4)),
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      const msg =
        body.error ||
        (Array.isArray(body.detail) ? body.detail[0]?.msg : body.detail) ||
        "Failed to start";
      toast.error(msg);
      addLog("ERROR", msg, "text-amber-700 font-semibold");
    } else {
      if (previewEnabledRef.current) startPreview(body.hls_url);
      toast.success(`Monitoring started @ ${body.sample_fps} FPS`);
      addLog("STARTED", `${body.channel_id} @ ${body.sample_fps} FPS · Alert ${body.alert_after_sec}s`);
    }
  }

  async function handleStop() {
    await fetch("/api/stop", { method: "POST" });
    stopPreview();
    toast("Monitoring stopped");
    addLog("STOPPED", "Monitoring stopped by user");
  }

  function updateRoiFromPixels(px, py, pw, ph) {
    const next = {
      x: Math.max(0, Math.min(0.9, px / wrapSize.width)),
      y: Math.max(0, Math.min(0.9, py / wrapSize.height)),
      w: Math.max(0.1, Math.min(1, pw / wrapSize.width)),
      h: Math.max(0.1, Math.min(1, ph / wrapSize.height)),
    };
    next.w = Math.min(next.w, 1 - next.x);
    next.h = Math.min(next.h, 1 - next.y);
    if (
      Math.abs(next.x - roi.x) < 0.002 &&
      Math.abs(next.y - roi.y) < 0.002 &&
      Math.abs(next.w - roi.w) < 0.002 &&
      Math.abs(next.h - roi.h) < 0.002
    ) {
      return;
    }
    setRoi(next);
    scheduleRestart(sampleFps, alertAfterSec, gridSizeRef.current, ecoModeRef.current, next);
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#f6f4ef] text-slate-900 p-6">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-28 -left-24 h-96 w-96 rounded-full bg-sky-200/45 blur-3xl" />
        <div className="absolute top-1/3 -right-24 h-[28rem] w-[28rem] rounded-full bg-amber-100/70 blur-3xl" />
        <div className="absolute -bottom-28 left-1/3 h-96 w-96 rounded-full bg-indigo-100/55 blur-3xl" />
      </div>

      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "rgba(255, 255, 255, 0.9)",
            backdropFilter: "blur(14px)",
            color: "#0f172a",
            border: "1px solid rgba(255, 255, 255, 0.95)",
            boxShadow: "0 10px 25px -8px rgba(15, 23, 42, 0.14)",
          },
        }}
      />
      <div className="relative max-w-7xl mx-auto space-y-4">
        <header className="wax-panel relative z-30 rounded-2xl px-5 py-3.5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-blue-50 text-blue-600 shadow-xs">
              <Activity className="w-5 h-5" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-slate-900">HLS Freeze Monitor</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-xl bg-slate-200/70 p-1 text-xs font-semibold">
              <button
                type="button"
                onClick={() => switchTab("monitor")}
                className={`px-3 py-1 rounded-lg cursor-pointer transition ${
                  activeTab === "monitor" ? "bg-white text-slate-900 shadow-xs" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                Monitor
              </button>
              <button
                type="button"
                onClick={() => switchTab("hld")}
                className={`px-3 py-1 rounded-lg cursor-pointer transition ${
                  activeTab === "hld" ? "bg-white text-slate-900 shadow-xs" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                HLD Diagram
              </button>
              <button
                type="button"
                onClick={() => switchTab("history")}
                className={`px-3 py-1 rounded-lg cursor-pointer transition ${
                  activeTab === "history" ? "bg-white text-slate-900 shadow-xs" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                History
              </button>
            </div>
            <BadgeWithDot type="pill-color" size="md" color={badge.color}>
              {badge.text}
            </BadgeWithDot>
            <div ref={notifRef} className="relative">
              <button
                type="button"
                aria-label="Event Notifications"
                onClick={() => {
                  setNotifOpen((prev) => !prev);
                  setUnreadCount(0);
                }}
                className="relative p-2 rounded-xl bg-white/80 hover:bg-white border border-slate-200/80 text-slate-700 shadow-xs cursor-pointer transition"
              >
                <Bell01 className="w-5 h-5" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 rounded-full bg-red-600 text-white text-[10px] font-bold flex items-center justify-center shadow-xs">
                    {unreadCount > 99 ? "99+" : unreadCount}
                  </span>
                )}
              </button>

              {notifOpen && (
                <div className="bg-white border border-slate-200 shadow-xl absolute right-0 mt-2.5 w-96 max-w-[90vw] rounded-2xl p-3.5 z-50">
                  <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-slate-200/80">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">Event Notifications</div>
                      <div className="text-[11px] text-slate-500 truncate max-w-[240px]">{streamInfo}</div>
                    </div>
                    {logs.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setLogs([]);
                          fetch("/api/logs", { method: "DELETE" }).catch(() => {});
                        }}
                        className="text-xs font-medium text-slate-500 hover:text-slate-900 cursor-pointer"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto font-mono text-xs divide-y divide-slate-200/70">
                    {logs.length === 0 ? (
                      <div className="py-4 text-center text-slate-500">
                        No events yet. Start monitoring to see freeze alerts.
                      </div>
                    ) : (
                      logs.map((item) => (
                        <div key={item.id} className="py-2.5 space-y-0.5">
                          <div className={`flex items-center justify-between gap-2 ${item.tone}`}>
                            <span>{item.label}</span>
                            <span className="text-[11px] text-slate-400 font-normal">{item.time}</span>
                          </div>
                          {item.detail && <div className="text-[11px] text-slate-500">{item.detail}</div>}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {activeTab === "hld" && (
          <Suspense fallback={<div className="flex items-center justify-center h-64 text-slate-400 text-sm">Loading HLD diagram…</div>}>
            <HldFlow />
          </Suspense>
        )}

        {activeTab === "history" && (
          <Suspense fallback={<div className="flex items-center justify-center h-64 text-slate-400 text-sm">Loading history…</div>}>
            <HistoryView />
          </Suspense>
        )}

        <div className={activeTab === "monitor" ? "grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4 items-start" : "hidden"}>
          {/* Left Column: Controls & Live Metrics */}
          <div className="space-y-4">
            <form onSubmit={handleStart} className="wax-panel rounded-2xl p-4 space-y-3">
              <Input
                label="HLS Stream URL (.m3u8)"
                type="url"
                isRequired
                value={hlsUrl}
                onChange={setHlsUrl}
                placeholder="https://example.com/live/stream.m3u8"
                wrapperClassName="bg-white/85"
              />
              <Input
                label="Channel ID"
                type="text"
                isRequired
                value={channelId}
                onChange={setChannelId}
                wrapperClassName="bg-white/85"
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Sample FPS"
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="30"
                  isRequired
                  value={sampleFps}
                  onChange={(v) => {
                    setSampleFps(v);
                    scheduleRestart(v, alertAfterSec);
                  }}
                  wrapperClassName="bg-white/85"
                />
                <Input
                  label="Alert (sec)"
                  type="number"
                  step="1"
                  min="1"
                  max="120"
                  isRequired
                  value={alertAfterSec}
                  onChange={(v) => {
                    setAlertAfterSec(v);
                    scheduleRestart(sampleFps, v);
                  }}
                  wrapperClassName="bg-white/85"
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">Detection Grid</span>
                  <span className="text-xs text-slate-500">
                    {gridSize === 2
                      ? "4 zones (minimal)"
                      : gridSize === 4
                        ? "16 zones (logo/ticker safe)"
                        : gridSize === 5
                          ? "25 zones (fine-grained)"
                          : "9 zones (standard)"}
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5 rounded-xl bg-slate-200/70 p-1">
                  {[
                    { size: 2, label: "2 × 2" },
                    { size: 3, label: "3 × 3" },
                    { size: 4, label: "4 × 4" },
                    { size: 5, label: "5 × 5" },
                  ].map((opt) => (
                    <button
                      key={opt.size}
                      type="button"
                      onClick={() => {
                        if (gridSize === opt.size) return;
                        setGridSize(opt.size);
                        setFrameState((prev) => ({ ...prev, zoneStates: [] }));
                        scheduleRestart(sampleFps, alertAfterSec, opt.size, ecoModeRef.current);
                      }}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
                        gridSize === opt.size
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">Decode Engine</span>
                  <span className="text-xs text-slate-500">
                    {activeDecoder ? `Active: ${activeDecoder.toUpperCase()}` : "Hybrid Auto-Detect"}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 rounded-xl bg-slate-200/70 p-1">
                  {[
                    { mode: "auto", label: "Auto" },
                    { mode: "cpu", label: "CPU" },
                    { mode: "gpu", label: "GPU" },
                  ].map((opt) => (
                    <button
                      key={opt.mode}
                      type="button"
                      onClick={() => {
                        if (decodeMode === opt.mode) return;
                        setDecodeMode(opt.mode);
                        scheduleRestart(sampleFps, alertAfterSec, gridSizeRef.current, ecoModeRef.current, roiRef.current, opt.mode);
                      }}
                      className={`rounded-lg px-2 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
                        decodeMode === opt.mode
                          ? "bg-white text-slate-900 shadow-xs"
                          : "text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-slate-200/55 px-3 py-2">
                <div>
                  <div className="text-xs font-semibold text-slate-800">Eco CPU Mode</div>
                  <div className="text-[11px] text-slate-500">
                    {ecoMode ? "1.0 FPS + 160×90 downscale (low CPU)" : "240×135 + reference frames"}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={ecoMode}
                  onClick={() => {
                    const next = !ecoMode;
                    setEcoMode(next);
                    scheduleRestart(sampleFps, alertAfterSec, gridSizeRef.current, next);
                  }}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
                    ecoMode ? "bg-emerald-600" : "bg-slate-300"
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition duration-200 ${
                      ecoMode ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3 pt-1">
                <Button type="submit" size="md" color="primary" isDisabled={isRunning} iconLeading={Play} className="w-full">
                  Start
                </Button>
                <Button type="button" size="md" color="primary-destructive" isDisabled={!isRunning} onClick={handleStop} iconLeading={StopSquare} className="w-full">
                  Stop
                </Button>
              </div>
            </form>

            <div className="grid grid-cols-2 gap-3">
              <div className="wax-panel rounded-2xl p-4">
                <div className="text-xs text-slate-500 mb-1">Stream State</div>
                <div
                  className={`text-xl font-bold tabular-nums ${
                    frameState.isFrozen === true
                      ? "text-red-600"
                      : frameState.isFrozen === false
                      ? "text-emerald-600"
                      : "text-slate-900"
                  }`}
                >
                  {frameState.state}
                </div>
              </div>
              <div className="wax-panel rounded-2xl p-4">
                <div className="text-xs text-slate-500 mb-1">Latest PTS (sec)</div>
                <div className="text-xl font-bold tabular-nums text-slate-900">{frameState.pts}</div>
              </div>
              <div className="wax-panel rounded-2xl p-4">
                <div className="text-xs text-slate-500 mb-1">Static Zones</div>
                <div className="text-xl font-bold tabular-nums text-slate-900">{frameState.zones}</div>
              </div>
              <div className="wax-panel rounded-2xl p-4">
                <div className="text-xs text-slate-500 mb-1">Freeze Ratio</div>
                <div className="text-xl font-bold tabular-nums text-slate-900">{frameState.ratio}</div>
                <div className="mt-2 h-1.5 bg-slate-200/80 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-200 ${
                      frameState.isStatic ? "bg-red-500" : "bg-emerald-500"
                    }`}
                    style={{ width: `${frameState.pct}%` }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Video Preview & System Telemetry */}
          <div className="space-y-4">
            <div className="wax-panel rounded-2xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <span className="text-sm font-semibold text-slate-900">HLS Preview (Drag / Resize Monitoring Area)</span>
              <div className="flex items-center gap-2.5 text-xs">
                <span className="text-slate-500">
                  Area {Math.round(roi.x * 100)}%,{Math.round(roi.y * 100)}% · {Math.round(roi.w * 100)}%×
                  {Math.round(roi.h * 100)}%
                </span>
                <span className="text-slate-500">{previewNote}</span>
                <Button
                  size="xs"
                  color="secondary"
                  onClick={() => {
                    const next = !previewEnabled;
                    setPreviewEnabled(next);
                    if (!next) {
                      stopPreview();
                      setPreviewNote("Preview paused (saving bandwidth)");
                    } else if (isRunningRef.current && hlsUrl.trim()) {
                      startPreview(hlsUrl.trim());
                    }
                  }}
                >
                  {previewEnabled ? "Pause Preview" : "Resume Preview"}
                </Button>
                <Button
                  size="xs"
                  color="secondary"
                  iconLeading={RefreshCw01}
                  onClick={() => {
                    setRoi(DEFAULT_ROI);
                    restartIfRunning(DEFAULT_ROI);
                  }}
                >
                  Full Area
                </Button>
                <Button
                  size="xs"
                  color="secondary"
                  iconLeading={Maximize02}
                  onClick={() => {
                    if (document.fullscreenElement) document.exitFullscreen();
                    else previewWrapRef.current?.requestFullscreen().catch(() => {});
                  }}
                >
                  Fullscreen
                </Button>
              </div>
            </div>

            <div
              ref={previewWrapRef}
              className="relative w-full aspect-video bg-slate-950 rounded-xl overflow-hidden border border-white/70 shadow-inner"
            >
              <video ref={videoRef} controls muted autoPlay playsInline className="w-full h-full object-contain block" />
              <Rnd
                bounds="parent"
                minWidth={Math.round(wrapSize.width * 0.1)}
                minHeight={Math.round(wrapSize.height * 0.1)}
                size={{
                  width: Math.round(roi.w * wrapSize.width),
                  height: Math.round(roi.h * wrapSize.height),
                }}
                position={{
                  x: Math.round(roi.x * wrapSize.width),
                  y: Math.round(roi.y * wrapSize.height),
                }}
                onDragStop={(_, d) =>
                  updateRoiFromPixels(d.x, d.y, roi.w * wrapSize.width, roi.h * wrapSize.height)
                }
                onResizeStop={(_, __, ref, ___, pos) =>
                  updateRoiFromPixels(pos.x, pos.y, ref.offsetWidth, ref.offsetHeight)
                }
                className="z-20 border-2 border-blue-500 bg-blue-500/10 shadow-[0_0_0_1px_rgba(255,255,255,0.85),inset_0_0_0_1px_rgba(0,0,0,0.45)]"
              >
                <div
                  className={`relative w-full h-full grid pointer-events-none ${
                    gridSize === 2
                      ? "grid-cols-2 grid-rows-2"
                      : gridSize === 4
                        ? "grid-cols-4 grid-rows-4"
                        : gridSize === 5
                          ? "grid-cols-5 grid-rows-5"
                          : "grid-cols-3 grid-rows-3"
                  }`}
                >
                  <span className="absolute -top-1.5 -left-1.5 w-3.5 h-3.5 bg-blue-600 border-2 border-white rounded-xs shadow-md" />
                  <span className="absolute -top-1.5 -right-1.5 w-3.5 h-3.5 bg-blue-600 border-2 border-white rounded-xs shadow-md" />
                  <span className="absolute -bottom-1.5 -left-1.5 w-3.5 h-3.5 bg-blue-600 border-2 border-white rounded-xs shadow-md" />
                  <span className="absolute -bottom-1.5 -right-1.5 w-3.5 h-3.5 bg-blue-600 border-2 border-white rounded-xs shadow-md" />
                  {Array.from({ length: gridSize * gridSize }).map((_, idx) => {
                    const expectedZones = gridSize * gridSize;
                    const hasZone = frameState.zoneStates.length === expectedZones;
                    const isZoneStatic = hasZone && Boolean(frameState.zoneStates[idx]);
                    const isZoneFrozen = isZoneStatic && Boolean(frameState.isFrozen);

                    const cellClass = !hasZone
                      ? "border border-dashed border-white/80 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.3)]"
                      : isZoneFrozen
                        ? "border border-red-400/90 bg-red-500/30 shadow-[inset_0_0_0_1px_rgba(239,68,68,0.45)]"
                        : isZoneStatic
                          ? "border border-amber-400/85 bg-amber-500/20 shadow-[inset_0_0_0_1px_rgba(245,158,11,0.35)]"
                          : "border border-dashed border-white/75 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.25)]";

                    return (
                      <div key={idx} className={`relative flex items-start justify-between p-1 transition-colors duration-150 ${cellClass}`}>
                        <span
                          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none tracking-tight backdrop-blur-xs ${
                            !hasZone
                              ? "bg-black/45 text-white/80"
                              : isZoneFrozen
                                ? "bg-red-600/90 text-white animate-pulse shadow-xs"
                                : isZoneStatic
                                  ? "bg-amber-500/90 text-slate-950 shadow-xs"
                                  : "bg-emerald-600/75 text-white/95"
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              !hasZone
                                ? "bg-white/60"
                                : isZoneFrozen
                                  ? "bg-white"
                                  : isZoneStatic
                                    ? "bg-slate-950"
                                    : "bg-emerald-200"
                            }`}
                          />
                          Z{idx + 1}
                          {hasZone && (isZoneFrozen ? " · FREEZE" : isZoneStatic ? " · STATIC" : " · OK")}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Rnd>
            </div>
            </div>

            <div className="wax-panel rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-xs font-semibold text-slate-700">System Telemetry (Live)</span>
                <div className="flex items-center gap-3">
                  <span className="text-[11px] text-slate-400">2s interval</span>
                  <a
                    href="/api/metrics/export"
                    download="freeze_metrics.csv"
                    className="text-[11px] font-medium text-blue-600 hover:text-blue-800 underline-offset-2 hover:underline"
                  >
                    Export CSV
                  </a>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-xl bg-white/75 px-3 py-2.5 border border-slate-200/70">
                  <div className="text-[11px] text-slate-500">CPU</div>
                  <div className="text-base font-bold tabular-nums text-slate-900">
                    {sysStats.cpu_pct != null ? `${sysStats.cpu_pct}%` : "—"}
                  </div>
                </div>
                <div className="rounded-xl bg-white/75 px-3 py-2.5 border border-slate-200/70">
                  <div className="text-[11px] text-slate-500">RAM</div>
                  <div className="text-base font-bold tabular-nums text-slate-900">
                    {sysStats.ram_mb != null ? `${sysStats.ram_mb} MiB` : "—"}
                  </div>
                </div>
                <div className="rounded-xl bg-white/75 px-3 py-2.5 border border-slate-200/70">
                  <div className="text-[11px] text-slate-500">Bandwidth</div>
                  <div className="text-base font-bold tabular-nums text-slate-900">
                    {sysStats.rx_mbps != null ? `${sysStats.rx_mbps} Mbps` : "—"}
                  </div>
                  {sysStats.tx_kbps != null && (
                    <div className="text-[10px] tabular-nums text-slate-400">↑ {sysStats.tx_kbps} KB/s</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
