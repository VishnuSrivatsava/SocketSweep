import { useEffect, useState } from "react";
import { Treemap, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import type { TreemapNode } from "recharts";
import { formatBytes } from "./formatBytes";
import type { ScanResponse } from "./scanView";
import { useScanView } from "./useScanView";
import { FileTreeNode, QueryError } from "./FileTree";
import { LargestFiles } from "./LargestFiles";
import { FileTypes } from "./FileTypes";
import { ScanHistory } from "./ScanHistory";

// ── Stat Card ───────────────────────────────────────────────────────────────

function StatCard({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="glass-card rounded-lg px-3 py-2 flex flex-col gap-0.5">
      <span className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">{label}</span>
      <span className={`text-lg font-bold font-mono tracking-tight ${accent ? "text-accent-400" : "text-zinc-100"}`}>
        {value}
      </span>
    </div>
  );
}

// ── Custom Treemap Content ──────────────────────────────────────────────────

const TreemapContent = (props: TreemapNode & { bgColors: string[] }) => {
  const { x, y, width, height, index, name, value, bgColors } = props;
  if (width < 30 || height < 30) return null;
  const bgColor = bgColors ? bgColors[index % bgColors.length] : "#0f172a";

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        style={{
          fill: bgColor,
          stroke: "#ffffff20",
          strokeWidth: 1,
        }}
      />
      {width > 50 && height > 30 && name && (
        <text x={x + 6} y={y + 18} fill="#fff" fontSize={11} className="font-sans font-medium pointer-events-none drop-shadow-md truncate max-w-full">
          {name}
        </text>
      )}
      {width > 50 && height > 45 && value !== undefined && (
        <text x={x + 6} y={y + 32} fill="#94a3b8" fontSize={9} className="font-mono pointer-events-none">
          {formatBytes(value)}
        </text>
      )}
    </g>
  );
};

// ── Result Screen ───────────────────────────────────────────────────────────

export function ResultScreen({
  data,
  onRescan,
  onDisconnect,
  onNuke,
  busy,
  deviceSerial,
}: {
  data: ScanResponse;
  onRescan: () => void;
  onDisconnect: () => void;
  onNuke: (nodeId: number) => void;
  busy: boolean;
  deviceSerial: string;
}) {
  const [zoomId, setZoomId] = useState(data.root.id);
  const [expanded, setExpanded] = useState(() => new Set([data.root.id]));
  const [mode, setMode] = useState<"map" | "largest" | "types">("map");
  const view = useScanView(data, zoomId, mode === "map");
  const page = view.page;
  const onZoom = (id: number) => {
    setExpanded(previous => new Set(previous).add(id));
    setZoomId(id);
    setMode("map");
  };
  const toggle = (id: number) => setExpanded(previous => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  useEffect(() => {
    if (view.error === "Scan node is no longer available") onZoom(data.root.id);
  }, [view.error, data.root.id]);

  const bgColors = [
    "#0d9488", "#0284c7", "#4f46e5", "#7c3aed", 
    "#c026d3", "#e11d48", "#ea580c", "#ca8a04",
  ];

  const treemapData = (page?.chart ?? []).map(tile => ({ ...tile, nodeId: tile.node_id }));
  const breadcrumbs = page?.breadcrumbs ?? [];

  return (
    <div className="flex flex-col h-full min-h-0 animate-fade-in-up">
      {/* Top bar */}
      <header className="flex items-center justify-between gap-3 px-4 py-2 border-b border-zinc-800/80 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <h1 className="text-base font-semibold text-zinc-200 tracking-tight">SocketSweep</h1>
          <div className="flex items-center text-xs text-zinc-500 font-mono">
            {breadcrumbs.map((crumb, idx) => (
              <span key={crumb.id} className="inline-flex items-center">
                <button 
                  disabled={busy} onClick={() => onZoom(crumb.id)}
                  className={`hover:text-zinc-300 transition-colors ${idx === breadcrumbs.length - 1 ? 'text-zinc-300 font-semibold' : ''}`}
                >
                  {crumb.name}
                </button>
                {idx < breadcrumbs.length - 1 && (
                  <span className="mx-2 opacity-50">&gt;</span>
                )}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {zoomId !== data.root.id && (
            <button
              disabled={busy} onClick={() => onZoom(data.root.id)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            >
              ← Back to Root
            </button>
          )}
          <button
            id="btn-rescan"
            disabled={busy} onClick={onRescan}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300
              hover:bg-zinc-700 hover:text-zinc-100 border border-zinc-700/50"
          >
            ↻ Rescan
          </button>
          <button
            id="btn-disconnect"
            disabled={busy} onClick={onDisconnect}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-400
              hover:bg-red-950/50 hover:text-red-400 border border-zinc-700/50"
          >
            Disconnect
          </button>
        </div>
      </header>

      <p id="connected-device" className="px-4 pt-2 text-xs text-zinc-500 break-all">Device: <span className="font-mono">{deviceSerial}</span></p>
      {data.read_only && (
        <div className="px-4 pt-2 text-xs text-accent-300">
          Root access · Read-only · Deletion disabled
        </div>
      )}
      <ScanHistory scope={data} />

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-4 py-2 shrink-0">
        <StatCard label="Total Size" value={formatBytes(data.total_size)} accent />
        <StatCard label="Files" value={data.total_files.toLocaleString("en-US")} />
        <StatCard label="Directories" value={data.total_dirs.toLocaleString("en-US")} />
        <StatCard label="Scan Time" value={`${data.scan_time_ms}ms`} />
      </div>

      <div className="flex gap-2 px-4 pb-2 shrink-0" role="group" aria-label="Scan view">
        <button aria-pressed={mode === "map"} disabled={busy} onClick={() => setMode("map")}
          className={`px-3 py-2 rounded-lg text-xs ${mode === "map" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400"}`}>Storage map</button>
        <button aria-pressed={mode === "largest"} disabled={busy} onClick={() => setMode("largest")}
          className={`px-3 py-2 rounded-lg text-xs ${mode === "largest" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400"}`}>Largest files</button>
        <button aria-pressed={mode === "types"} disabled={busy} onClick={() => setMode("types")}
          className={`px-3 py-2 rounded-lg text-xs ${mode === "types" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400"}`}>File types</button>
      </div>
      {mode === "types" ? <FileTypes scope={data} busy={busy} /> : mode === "largest" ? <LargestFiles scope={data} busy={busy} onZoom={onZoom} onNuke={onNuke} /> : <div className="flex-1 min-h-0 grid grid-rows-[7rem_minmax(0,1fr)] md:grid-rows-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 px-4 pb-3">
      {/* Treemap */}
      <div className="min-h-0 min-w-0">
        <div className="glass-card rounded-xl p-2 w-full h-full relative group">
          <ResponsiveContainer width="100%" height="100%">
            <Treemap
              data={treemapData}
              dataKey="size"
              aspectRatio={4 / 3}
              stroke="#fff"
              content={node => <TreemapContent {...node} bgColors={bgColors} />}
              isAnimationActive={false}
              onClick={(e) => {
                if (!busy && typeof e?.nodeId === "number") onZoom(e.nodeId);
              }}
            >
              <RechartsTooltip 
                content={({ active, payload }) => {
                  if (active && payload && payload.length) {
                    const p = payload[0].payload;
                    return (
                      <div className="bg-zinc-900 border border-zinc-800 p-2 rounded shadow-xl text-xs z-50">
                        <p className="font-semibold text-zinc-200">{p.name}</p>
                        <p className="text-zinc-400 font-mono mt-1">{formatBytes(p.size)}</p>
                        {p.node_id !== null && <p className="text-zinc-600 mt-1">Click to Zoom</p>}
                      </div>
                    );
                  }
                  return null;
                }}
              />
            </Treemap>
          </ResponsiveContainer>
        </div>
      </div>

      {/* File tree */}
      <section aria-label="Files and folders" className="glass-card rounded-xl overflow-y-auto px-2 pb-3 min-h-0 min-w-0">
        <div className="flex items-center gap-2 px-3 py-2 mb-1">
          <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex-1">Files and folders</span>
          <span className="text-xs text-zinc-500">
            {[data.errors > 0 ? `${data.errors} access errors` : "", data.skipped > 0 ? `${data.skipped} excluded or duplicate entries` : ""].filter(Boolean).join(" · ")}
          </span>
        </div>
        {!page && !view.error && <p role="status" className="px-3 py-2 text-xs text-zinc-500">Loading storage map…</p>}
        {view.error && <QueryError error={view.error} retry={view.retry} />}
        {page && <FileTreeNode node={page.node} scope={data} parentSize={page.node.size} depth={0}
          onNuke={onNuke} onZoom={onZoom} expanded={expanded} toggle={toggle} busy={busy} rootView={view} />}

      </section>
      </div>}
    </div>
  );
}

