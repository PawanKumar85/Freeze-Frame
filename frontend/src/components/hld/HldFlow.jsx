import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const TONE_STYLES = {
  blue: {
    box: "border-blue-500/80 bg-blue-950/50",
    title: "text-blue-300",
    minimap: "#3b82f6",
  },
  orange: {
    box: "border-amber-500/80 bg-amber-950/45",
    title: "text-amber-300",
    minimap: "#f59e0b",
  },
  green: {
    box: "border-emerald-500/80 bg-emerald-950/45",
    title: "text-emerald-300",
    minimap: "#22c55e",
  },
  violet: {
    box: "border-purple-500/80 bg-purple-950/50",
    title: "text-purple-300",
    minimap: "#a855f7",
  },
  red: {
    box: "border-red-500/80 bg-red-950/50",
    title: "text-red-300",
    minimap: "#ef4444",
  },
  grey: {
    box: "border-slate-500/70 bg-slate-900/80",
    title: "text-slate-200",
    minimap: "#64748b",
  },
};

function HldNode({ data }) {
  const tone = TONE_STYLES[data.tone] || TONE_STYLES.grey;
  return (
    <div className={`rounded-xl border-[1.5px] px-4 py-3 shadow-xl backdrop-blur-md min-w-[215px] max-w-[310px] font-mono text-[11px] leading-relaxed text-slate-200 ${tone.box}`}>
      <Handle type="target" position={Position.Left} id="l" className="!bg-slate-400 !w-2 !h-2" />
      <Handle type="target" position={Position.Top} id="t" className="!bg-slate-400 !w-2 !h-2" />
      <Handle type="source" position={Position.Right} id="r" className="!bg-slate-400 !w-2 !h-2" />
      <Handle type="source" position={Position.Bottom} id="b" className="!bg-slate-400 !w-2 !h-2" />
      <Handle type="source" position={Position.Top} id="st" className="!bg-slate-400 !w-2 !h-2" />

      <div className={`font-sans text-[13px] font-bold mb-1.5 flex items-center gap-2 ${tone.title}`}>
        {data.step && (
          <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white/15 text-white text-[11px]">
            {data.step}
          </span>
        )}
        <span>{data.title}</span>
      </div>
      <div className="space-y-0.5">
        {data.lines.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
      {data.footer && <div className="text-[10px] text-slate-400 mt-1.5">{data.footer}</div>}
    </div>
  );
}

function WorkerGroupNode({ data }) {
  return (
    <div className="w-full h-full rounded-2xl border-[1.5px] border-dashed border-amber-500/60 bg-amber-500/[0.03] relative">
      <div className="absolute -top-3 left-4 bg-[#0b0e14] px-2 text-[11px] font-mono font-bold tracking-wider text-amber-300">
        {data.label}
      </div>
    </div>
  );
}

const nodeTypes = { hld: HldNode, workerGroup: WorkerGroupNode };

const INITIAL_NODES = [
  {
    id: "worker-group",
    type: "workerGroup",
    position: { x: 270, y: 230 },
    style: { width: 1030, height: 245, zIndex: -1 },
    data: { label: "MONITOR WORKER · IN-PROCESS RUST + PYTHON (ZERO-COPY)" },
    selectable: false,
    draggable: false,
  },
  {
    id: "hls-source",
    type: "hld",
    position: { x: 10, y: 20 },
    data: {
      tone: "violet",
      title: "HLS Stream Source",
      lines: ["index.m3u8 (lowest variant auto-pick)", "mono.m3u8 + .ts segments"],
      footer: "HTTP/HTTPS (reconnect=1, persistent)",
    },
  },
  {
    id: "models-cfg",
    type: "hld",
    position: { x: 290, y: 20 },
    data: {
      tone: "green",
      title: "Models & Thresholds",
      lines: [
        "StreamExtract: 2 FPS, 240×135 (Eco: 1 FPS, 160×90)",
        "ZoneMetric: 2×2 / 3×3 / 4×4 · MAE ≤ 1.0",
        "Motion ≤ 1.5%, SSIM ≥ 0.995, ratio 0.75/0.88/0.85",
      ],
      footer: "StateMachine: 10000ms · backend/models/",
    },
  },
  {
    id: "hls-meta",
    type: "hld",
    position: { x: 650, y: 20 },
    data: {
      tone: "green",
      title: "HLS Metadata (hls_metadata.py)",
      lines: [
        "httpx pooled client (polls .m3u8 every 6s)",
        "resolve_lowest_variant_url()",
        "#EXT-X-TARGETDURATION + MEDIA-SEQUENCE",
      ],
      footer: "backend/detector/hls_metadata.py",
    },
  },
  {
    id: "step-6-sse",
    type: "hld",
    position: { x: 1350, y: 278 },
    data: {
      step: "6",
      tone: "blue",
      title: "SseBroadcaster + Telemetry",
      lines: [
        "GET /api/events (asyncio.Queue, no thread/msg)",
        "_SystemStatsSampler (/proc CPU, RAM, BW @ 2s)",
      ],
      footer: "status | frame | alert | error_msg | sys_stats",
    },
  },
  {
    id: "step-1-api",
    type: "hld",
    position: { x: 10, y: 268 },
    data: {
      step: "1",
      tone: "blue",
      title: "FastAPI Server",
      lines: [
        "POST /api/start (grid 2|3|4, eco_mode)",
        "GET /api/status, /api/logs, /api/metrics",
        "GET /api/metrics/export (CSV) · /assets immutable",
      ],
      footer: "backend/server.py · uvicorn[standard] :8000",
    },
  },
  {
    id: "step-2-demux",
    type: "hld",
    position: { x: 290, y: 268 },
    data: {
      step: "2",
      tone: "orange",
      title: "Demux & Decode",
      lines: [
        "NativeFrameExtractor + AVIOInterruptCB",
        "skip_frame=NONREF, skip_loop_filter=ALL",
        "Non-video streams AVDISCARD_ALL",
      ],
      footer: "count=1 decoder · rust_frame_reader/lib.rs",
    },
  },
  {
    id: "step-3-roi",
    type: "hld",
    position: { x: 545, y: 268 },
    data: {
      step: "3",
      tone: "orange",
      title: "ROI Crop & Sample",
      lines: [
        "2.0 FPS PTS sampler (Eco: 1.0 FPS)",
        "Resets on PTS jump/backward",
        "SwsContext FAST_BILINEAR scale →",
      ],
      footer: "240×135 / 160×90 GRAY8 (reused buffer)",
    },
  },
  {
    id: "step-4-algo",
    type: "hld",
    position: { x: 795, y: 268 },
    data: {
      step: "4",
      tone: "orange",
      title: "3-Algo Evaluation",
      lines: [
        "1) MAE ≤ 1.0",
        "2) Motion (|d|>6) ≤ 1.5%",
        "3) 2D Prefix-Sum SSIM ≥ 0.995",
      ],
      footer: "2×2 / 3×3 / 4×4 grid (GIL-free Rust)",
    },
  },
  {
    id: "step-5-sm",
    type: "hld",
    position: { x: 1050, y: 268 },
    data: {
      step: "5",
      tone: "orange",
      title: "State & Watchdog",
      lines: [
        "FreezeStateMachine (per-zone + global)",
        "PTS_DISCONTINUITY_RESET",
        "Watchdog (2s tick + media_sequence)",
      ],
      footer: "backend/detector/state_machine.py",
    },
  },
  {
    id: "step-7-ui",
    type: "hld",
    position: { x: 1680, y: 205 },
    data: {
      step: "7",
      tone: "blue",
      title: "React + Vite UI (Code-Split)",
      lines: [
        "Light Wax Glass · Untitled UI",
        "Grid 2×2|3×3|4×4 + Eco Mode + Pause Preview",
        "Per-cell Z1..Z16 live alerts (react-rnd)",
        "Live Telemetry (CPU/RAM/BW) + Export CSV",
        "Lazy /hld React Flow · Bell + SQLite Logs",
      ],
      footer: "frontend/src/App.jsx + HldFlow.jsx",
    },
  },
  {
    id: "how-it-runs",
    type: "hld",
    position: { x: 10, y: 525 },
    data: {
      tone: "grey",
      title: "How it runs (Dockerfile)",
      lines: [
        "Multi-stage: node:20 + rust/maturin",
        "Runtime: python:3.11 + libav* + uvloop",
        "MALLOC_ARENA_MAX=2 · WORKDIR /app/backend",
      ],
      footer: "HEALTHCHECK :8000/api/status (30s)",
    },
  },
  {
    id: "sqlite-store",
    type: "hld",
    position: { x: 1050, y: 525 },
    data: {
      tone: "green",
      title: "SQLite Store (log_store.py)",
      lines: [
        "freeze_logs.db (WAL mode, 0 extra RAM)",
        "alert_logs (5k) + metric_logs (20k)",
        "State, PTS, Zones, Ratio, CPU, RAM, BW",
      ],
      footer: "GET /api/logs · /api/metrics/export",
    },
  },
  {
    id: "alerts-box",
    type: "hld",
    position: { x: 640, y: 525 },
    data: {
      tone: "red",
      title: "Alert & Error Paths",
      lines: [
        "· FREEZE_DETECTED (10s) → Toast + Bell + DB",
        "· SEGMENT_DELAY (frame gap or seq stall)",
        "· 404 / Stream Error → error_msg SSE + DB",
      ],
    },
  },
];

const mkEdge = (id, source, target, color, opts = {}) => ({
  id,
  source,
  target,
  sourceHandle: opts.sh || "r",
  targetHandle: opts.th || "l",
  label: opts.label,
  animated: Boolean(opts.animated),
  style: { stroke: color, strokeWidth: 1.8, strokeDasharray: opts.dashed ? "6 4" : undefined },
  labelStyle: { fill: color, fontSize: 11, fontFamily: "ui-monospace, monospace" },
  labelBgStyle: { fill: "#0b0e14", fillOpacity: 0.85 },
  markerEnd: { type: MarkerType.ArrowClosed, color },
});

const INITIAL_EDGES = [
  mkEdge("e-src-demux", "hls-source", "step-2-demux", "#c084fc", { sh: "b", th: "t", label: ".ts segments", animated: true }),
  mkEdge("e-cfg-algo", "models-cfg", "step-4-algo", "#4ade80", { sh: "b", th: "t", label: "thresholds" }),
  mkEdge("e-meta-sm", "hls-meta", "step-5-sm", "#4ade80", { sh: "b", th: "t", label: "target_dur + PDT" }),
  mkEdge("e-1-2", "step-1-api", "step-2-demux", "#60a5fa", { label: "start" }),
  mkEdge("e-2-3", "step-2-demux", "step-3-roi", "#fbbf24", { animated: true }),
  mkEdge("e-3-4", "step-3-roi", "step-4-algo", "#fbbf24", { animated: true }),
  mkEdge("e-4-5", "step-4-algo", "step-5-sm", "#fbbf24", { animated: true }),
  mkEdge("e-5-6", "step-5-sm", "step-6-sse", "#60a5fa", { label: "events", animated: true }),
  mkEdge("e-6-7", "step-6-sse", "step-7-ui", "#60a5fa", { dashed: true, animated: true, label: "SSE (frame, alert, sys_stats)" }),
  mkEdge("e-5-alert", "step-5-sm", "alerts-box", "#f87171", { sh: "b", th: "t", label: "alerts" }),
  mkEdge("e-alert-6", "alerts-box", "step-6-sse", "#f87171", { sh: "r", th: "b", label: "alert / error_msg", animated: true }),
  mkEdge("e-6-db", "step-6-sse", "sqlite-store", "#4ade80", { sh: "b", th: "r", label: "save all logs" }),
  mkEdge("e-db-7", "sqlite-store", "step-7-ui", "#4ade80", { sh: "r", th: "b", dashed: true, label: "/api/logs & CSV" }),
];

export default function HldFlow() {
  const [nodes, , onNodesChange] = useNodesState(INITIAL_NODES);
  const [edges, , onEdgesChange] = useEdgesState(INITIAL_EDGES);

  return (
    <div className="rounded-2xl overflow-hidden border border-slate-800 bg-[#0b0e14] shadow-2xl">
      <div className="px-5 py-3.5 border-b border-slate-800/90 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-bold text-slate-100">HLS Freeze Monitor — Interactive HLD (React Flow)</h2>
          <p className="text-[11px] font-mono text-slate-400">
            HIGH-LEVEL DESIGN · DRAG NODES, PAN &amp; ZOOM · CHECKED AGAINST SOURCE
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-[11px] font-mono text-slate-400">
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-blue-500" />API &amp; UI</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-amber-500" />Rust/Python</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-emerald-500" />Config/Meta</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-purple-500" />HLS Source</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full bg-red-500" />Alerts</span>
        </div>
      </div>

      <div className="h-[680px] w-full">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          fitViewOptions={{ padding: 0.14 }}
        >
          <Background color="#1e293b" gap={20} />
          <Controls />
          <MiniMap
            nodeColor={(n) => TONE_STYLES[n.data?.tone]?.minimap || "#334155"}
            maskColor="rgba(11, 14, 20, 0.75)"
          />
        </ReactFlow>
      </div>
    </div>
  );
}
