import { useEffect, useMemo, useState } from "react";
import { RefreshCw01 } from "@untitledui/icons";
import { BadgeWithDot } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";

export default function HistoryView() {
  const [alerts, setAlerts] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    setLoading(true);
    try {
      const [aRes, mRes] = await Promise.all([
        fetch("/api/logs?limit=150"),
        fetch("/api/metrics?limit=300"),
      ]);
      const [aJson, mJson] = await Promise.all([aRes.json(), mRes.json()]);
      setAlerts(Array.isArray(aJson.logs) ? aJson.logs : []);
      setMetrics(Array.isArray(mJson.metrics) ? mJson.metrics : []);
    } catch {
      // ignore transient network errors
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  const summary = useMemo(() => {
    const total = metrics.length;
    if (total === 0) {
      return { total: 0, normalPct: "—", frozenCount: 0, avgCpu: "—", avgRam: "—", avgRx: "—" };
    }
    let frozenCount = 0;
    let cpuSum = 0, cpuN = 0;
    let ramSum = 0, ramN = 0;
    let rxSum = 0, rxN = 0;
    for (const m of metrics) {
      if (m.stream_state === "FROZEN") frozenCount += 1;
      if (typeof m.cpu_pct === "number") { cpuSum += m.cpu_pct; cpuN += 1; }
      if (typeof m.ram_mb === "number") { ramSum += m.ram_mb; ramN += 1; }
      if (typeof m.rx_mbps === "number") { rxSum += m.rx_mbps; rxN += 1; }
    }
    return {
      total,
      normalPct: `${(((total - frozenCount) / total) * 100).toFixed(1)}%`,
      frozenCount,
      avgCpu: cpuN ? `${(cpuSum / cpuN).toFixed(1)}%` : "—",
      avgRam: ramN ? `${(ramSum / ramN).toFixed(1)} MiB` : "—",
      avgRx: rxN ? `${(rxSum / rxN).toFixed(2)} Mbps` : "—",
    };
  }, [metrics]);

  return (
    <div className="space-y-4">
      <div className="wax-panel rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">SQLite History &amp; Analytics</h2>
          <p className="text-xs text-slate-500">
            Persisted in <code className="font-mono">backend/data/freeze_logs.db</code> (showing latest {metrics.length} samples &amp; {alerts.length} events)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" color="secondary" iconLeading={RefreshCw01} onClick={loadData} isDisabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
          <a
            href="/api/metrics/export"
            download="freeze_metrics.csv"
            className="inline-flex items-center rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 transition"
          >
            Export CSV
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: "Samples Loaded", value: summary.total },
          { label: "Normal Rate", value: summary.normalPct },
          { label: "Frozen Samples", value: summary.frozenCount },
          { label: "Avg CPU", value: summary.avgCpu },
          { label: "Avg RAM", value: summary.avgRam },
          { label: "Avg Bandwidth", value: summary.avgRx },
        ].map((card) => (
          <div key={card.label} className="wax-panel rounded-2xl p-3.5">
            <div className="text-[11px] text-slate-500 mb-0.5">{card.label}</div>
            <div className="text-lg font-bold tabular-nums text-slate-900">{card.value}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[420px_1fr] gap-4 items-start">
        <div className="wax-panel rounded-2xl p-4">
          <div className="text-sm font-semibold text-slate-900 mb-3">Alert &amp; Session Logs</div>
          <div className="max-h-[460px] overflow-y-auto divide-y divide-slate-200/70 font-mono text-xs">
            {alerts.length === 0 ? (
              <div className="py-6 text-center text-slate-500">No alert logs recorded yet.</div>
            ) : (
              alerts.map((a) => (
                <div key={a.id} className="py-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-800 truncate">
                      {a.event} {a.channel_id ? `(${a.channel_id})` : ""}
                    </div>
                    <div className="text-[11px] text-slate-500 break-words">{a.detail}</div>
                  </div>
                  <span className="text-[11px] text-slate-400 shrink-0">
                    {new Date(a.created_at).toLocaleTimeString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="wax-panel rounded-2xl p-4 overflow-hidden">
          <div className="text-sm font-semibold text-slate-900 mb-3">Recent Frame &amp; Telemetry Metrics</div>
          <div className="max-h-[460px] overflow-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead className="sticky top-0 bg-white/95 backdrop-blur-xs text-[11px] text-slate-500 border-b border-slate-200">
                <tr>
                  <th className="py-2 pr-3">Time</th>
                  <th className="py-2 pr-3">State</th>
                  <th className="py-2 pr-3">PTS (s)</th>
                  <th className="py-2 pr-3">Zones</th>
                  <th className="py-2 pr-3">Grid Map</th>
                  <th className="py-2 pr-3">Ratio</th>
                  <th className="py-2 pr-3">CPU</th>
                  <th className="py-2 pr-3">RAM</th>
                  <th className="py-2 pr-3">RX</th>
                  <th className="py-2">Delay</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60">
                {metrics.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-6 text-center text-slate-500">
                      No frame metrics recorded yet.
                    </td>
                  </tr>
                ) : (
                  metrics.map((m) => (
                    <tr key={m.id} className="hover:bg-white/60">
                      <td className="py-1.5 pr-3 text-slate-500 whitespace-nowrap">
                        {new Date(m.created_at).toLocaleTimeString()}
                      </td>
                      <td className="py-1.5 pr-3">
                        <BadgeWithDot
                          type="pill-color"
                          size="sm"
                          color={m.stream_state === "FROZEN" ? "error" : "success"}
                        >
                          {m.stream_state}
                        </BadgeWithDot>
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-800">{m.pts_sec ?? "—"}</td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-800">{m.static_zones ?? "—"}</td>
                      <td className="py-1.5 pr-3">
                        {Array.isArray(m.zone_states) ? (
                          <div
                            className={`inline-grid gap-0.5 ${
                              m.zone_states.length === 4
                                ? "grid-cols-2"
                                : m.zone_states.length === 16
                                  ? "grid-cols-4"
                                  : m.zone_states.length === 25
                                    ? "grid-cols-5"
                                    : "grid-cols-3"
                            }`}
                            title={m.zone_states.map((z, i) => `Z${i + 1}:${z ? "STATIC" : "OK"}`).join(" ")}
                          >
                            {m.zone_states.map((isStatic, i) => (
                              <span
                                key={i}
                                className={`h-2 w-2 rounded-[2px] ${
                                  isStatic ? "bg-red-500" : "bg-emerald-400/80"
                                }`}
                              />
                            ))}
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-800">{m.freeze_ratio ?? "—"}</td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-800">
                        {m.cpu_pct != null ? `${m.cpu_pct}%` : "—"}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-800">
                        {m.ram_mb != null ? `${m.ram_mb}M` : "—"}
                      </td>
                      <td className="py-1.5 pr-3 tabular-nums text-slate-800">
                        {m.rx_mbps != null ? `${m.rx_mbps}` : "—"}
                      </td>
                      <td className="py-1.5 tabular-nums text-slate-500">
                        {m.hls_live_delay_sec != null ? `${m.hls_live_delay_sec}s` : "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
