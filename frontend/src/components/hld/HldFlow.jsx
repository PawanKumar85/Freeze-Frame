const TONES = {
  violet: "border-purple-500/70 bg-[#1a1329]",
  green: "border-emerald-500/70 bg-[#0d211a]",
  blue: "border-blue-500/70 bg-[#0f1b2e]",
  orange: "border-amber-500/70 bg-[#23180c]",
  red: "border-red-500/70 bg-[#261114]",
  grey: "border-slate-600/70 bg-[#141922]",
};

const BADGE_TONES = {
  violet: "bg-purple-500/20 text-purple-300 border-purple-400/40",
  green: "bg-emerald-500/20 text-emerald-300 border-emerald-400/40",
  blue: "bg-blue-500/20 text-blue-300 border-blue-400/40",
  orange: "bg-amber-500/20 text-amber-300 border-amber-400/40",
  red: "bg-red-500/20 text-red-300 border-red-400/40",
  grey: "bg-slate-500/20 text-slate-300 border-slate-400/40",
};

function HldCard({ step, tone, title, lines, footer, className = "" }) {
  return (
    <div
      className={`rounded-xl border px-3.5 py-2.5 text-left shadow-lg backdrop-blur-xs ${TONES[tone]} ${className}`}
    >
      <div className="flex items-center gap-2 mb-1">
        {step && (
          <span
            className={`inline-flex items-center justify-center w-5 h-5 rounded-md border text-[10px] font-bold font-mono shrink-0 ${BADGE_TONES[tone]}`}
          >
            {step}
          </span>
        )}
        <div className="text-[12.5px] font-semibold text-slate-100 leading-tight">{title}</div>
      </div>
      <div className="space-y-0.5 text-[11px] font-mono text-slate-300/90 leading-snug">
        {lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
      {footer && (
        <div className="mt-1.5 pt-1 border-t border-white/10 text-[10px] font-mono text-slate-400">{footer}</div>
      )}
    </div>
  );
}

export default function HldFlow() {
  return (
    <div className="rounded-2xl overflow-hidden border border-slate-800 bg-[#0b0e14] shadow-2xl">
      <div className="px-5 py-3.5 border-b border-slate-800/90 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-slate-100">HLS Freeze Monitor — High-Level Design</h2>
          <p className="text-[11px] font-mono text-slate-400">
            ARCHITECTURE · ZERO-COPY RUST + FASTAPI + SQLITE · CHECKED AGAINST SOURCE
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-[11px] font-mono text-slate-400">
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-blue-500" />API &amp; UI</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-amber-500" />Rust/Python</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-emerald-500" />Config/DB</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-purple-500" />HLS Source</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-red-500" />Alerts</span>
        </div>
      </div>

      <div className="overflow-x-auto p-5 bg-[radial-gradient(#1e293b_1px,transparent_1px)] [background-size:20px_20px]">
        <div className="min-w-[1120px] space-y-5">
          {/* Row 1: Sources & Config */}
          <div className="grid grid-cols-12 gap-4 items-stretch">
            <div className="col-span-3">
              <HldCard
                tone="violet"
                title="HLS Stream Source"
                lines={["index.m3u8 (lowest variant auto-pick)", "mono.m3u8 + .ts segments"]}
                footer="HTTP/HTTPS (reconnect=1, rw_timeout=8s)"
                className="h-full"
              />
            </div>
            <div className="col-span-5">
              <HldCard
                tone="green"
                title="Models & Thresholds"
                lines={[
                  "StreamExtract: 1 FPS, 240×135 (Eco: 160×90)",
                  "ZoneMetric: 2×2 / 3×3 / 4×4 / 5×5 · MAE ≤ 0.6",
                  "Motion (|d|>4) ≤ 0.8%, SSIM ≥ 0.997, ratio 0.90–0.95",
                ]}
                footer="StateMachine: 10000ms · backend/models/"
                className="h-full"
              />
            </div>
            <div className="col-span-4">
              <HldCard
                tone="green"
                title="HLS Metadata (hls_metadata.py)"
                lines={[
                  "httpx pooled client (polls .m3u8 every 6s)",
                  "resolve_lowest_variant_url() + segment probe",
                  "#EXT-X-TARGETDURATION + MEDIA-SEQUENCE",
                ]}
                footer="backend/detector/hls_metadata.py"
                className="h-full"
              />
            </div>
          </div>

          {/* Row 2: Main Pipeline 1 -> [2 -> 3 -> 4 -> 5] -> 6 -> 7 */}
          <div className="grid grid-cols-[1.15fr_3.6fr_1.15fr_1.3fr] gap-3 items-center">
            <HldCard
              step="1"
              tone="blue"
              title="FastAPI Server"
              lines={[
                "POST /api/start (grid 2–5, eco, decode)",
                "GET /api/status, /api/logs, /api/metrics",
                "GZip + /api/metrics/export (CSV)",
              ]}
              footer="backend/server.py · uvicorn[standard] :8000"
            />

            <div className="rounded-xl border border-dashed border-amber-500/45 bg-amber-950/15 p-3">
              <div className="text-[10px] font-mono uppercase tracking-wider text-amber-300/90 mb-2">
                Monitor Worker · In-Process Rust + Python (Zero-Copy)
              </div>
              <div className="grid grid-cols-4 gap-2.5">
                <HldCard
                  step="2"
                  tone="orange"
                  title="Demux & Decode"
                  lines={[
                    "Hybrid Auto/CPU/GPU",
                    "VideoToolbox/CUDA/VAAPI",
                    "NONREF · loop_filter=ALL",
                  ]}
                  footer="rust_frame_reader/lib.rs"
                />
                <HldCard
                  step="3"
                  tone="orange"
                  title="ROI Crop & Sample"
                  lines={[
                    "1.0 FPS PTS sampler",
                    "Resets on PTS jump",
                    "FAST_BILINEAR scale",
                  ]}
                  footer="240×135 / 160×90 GRAY8"
                />
                <HldCard
                  step="4"
                  tone="orange"
                  title="4-Algo Evaluation"
                  lines={[
                    "1) MAE ≤ 0.6",
                    "2) Motion ≤ 0.8%",
                    "3) SSIM ≥ 0.997",
                    "4) dHash + 32×18 loop",
                  ]}
                  footer="2×2–5×5 (GIL-free Rust)"
                />
                <HldCard
                  step="5"
                  tone="orange"
                  title="State & Watchdog"
                  lines={[
                    "FreezeStateMachine",
                    "Watchdog (2s tick)",
                    "Segment timeout probe",
                  ]}
                  footer="state_machine.py"
                />
              </div>
            </div>

            <HldCard
              step="6"
              tone="blue"
              title="SseBroadcaster"
              lines={[
                "GET /api/events",
                "asyncio.Queue (0 threads)",
                "_SystemStatsSampler (2s)",
              ]}
              footer="status | frame | alert | sys_stats"
            />

            <HldCard
              step="7"
              tone="blue"
              title="React + Vite UI"
              lines={[
                "Light Wax · Untitled UI",
                "2×2..5×5 + Eco + Auto/CPU/GPU",
                "Per-cell Z1..Z25 alerts",
                "Telemetry + /history + /hld",
              ]}
              footer="frontend/src/App.jsx"
            />
          </div>

          {/* Row 3: Infra, Alerts, SQLite */}
          <div className="grid grid-cols-12 gap-4 items-stretch">
            <div className="col-span-3">
              <HldCard
                tone="grey"
                title="How it runs (Docker Compose)"
                lines={[
                  "Multi-stage: node:20 + rust/maturin",
                  "Runtime: python:3.11 + libav* + uvloop",
                  "Volume: ./backend/data:/app/backend/data",
                ]}
                footer="HEALTHCHECK :8000/api/status (30s)"
                className="h-full"
              />
            </div>
            <div className="col-span-5">
              <HldCard
                tone="red"
                title="Alert & Error Paths (→ SSE + SQLite)"
                lines={[
                  "· FREEZE_DETECTED / FREEZE_RECOVERED → Toast + Bell + DB",
                  "· SEGMENT_DELAY & SEGMENT_DOWNLOAD_TIMEOUT → SSE + DB",
                  "· 404 / Stream Error → error_msg SSE + DB",
                ]}
                className="h-full"
              />
            </div>
            <div className="col-span-4">
              <HldCard
                tone="green"
                title="SQLite Store (log_store.py)"
                lines={[
                  "freeze_logs.db (TRUNCATE, batched 10 rows)",
                  "alert_logs + metric_logs (zone_mask bitmask)",
                  "State, PTS, Zones, Ratio, CPU, RAM, RX/TX",
                ]}
                footer="GET /api/logs · /api/metrics · /api/metrics/export"
                className="h-full"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
