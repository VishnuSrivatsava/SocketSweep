import { useState, useCallback, useEffect, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { Treemap, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import { formatBytes } from "./formatBytes";
import { sameScan } from "./scanView";
import type { ScanNode, ScanResponse, NodeDetail, DeleteResult } from "./scanView";
import { useScanView } from "./useScanView";
import "./App.css";

// ── Types ───────────────────────────────────────────────────────────────────

/** One-line phase breakdown for the terminal log; null if the daemon predates #3. */
const scanPhaseLog = (r: ScanResponse): string | null => {
  if (r.traverse_ms === undefined) return null;
  const kb = r.bytes_sent !== undefined ? `, ${(r.bytes_sent / 1024).toFixed(0)} KB sent` : "";
  return `[SCAN] ${r.streamed ? "Stream timings (overlap): scan" : "Phases: traverse"} ${r.traverse_ms}ms · sort ${r.sort_ms}ms · serialize ${r.serialize_ms}ms · send ${r.send_ms}ms${kb}`;
};

interface Toast {
  id: number;
  message: string;
  type: "error" | "success" | "info";
  exiting?: boolean;
}

type AppPhase = "setup" | "connecting" | "scanning" | "result";

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// ── Icons (inline SVG) ──────────────────────────────────────────────────────

function IconFolder({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 3C1.5 2.44772 1.94772 2 2.5 2H6.29289L7.64645 3.35355L7.85355 3.5H8H13.5C14.0523 3.5 14.5 3.94772 14.5 4.5V12.5C14.5 13.0523 14.0523 13.5 13.5 13.5H2.5C1.94772 13.5 1.5 13.0523 1.5 12.5V3Z" fill="currentColor" opacity="0.2" stroke="currentColor" strokeWidth="1"/>
    </svg>
  );
}

function IconFile({ className = "" }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M4 1.5h5.586L13 4.914V14a.5.5 0 01-.5.5h-8A.5.5 0 014 14V2a.5.5 0 01.5-.5z" stroke="currentColor" strokeWidth="1" fill="none"/>
      <path d="M9.5 1.5V5H13" stroke="currentColor" strokeWidth="1" fill="none"/>
    </svg>
  );
}

function IconChevron({ open, className = "" }: { open: boolean; className?: string }) {
  return (
    <svg className={`transition-transform duration-200 ${open ? "rotate-90" : ""} ${className}`} width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function IconUsb() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-8m0 0V6m0 8l4-2v-2m-4 4l-4-2v-2"/>
      <circle cx="12" cy="4" r="2"/>
      <circle cx="8" cy="10" r="1"/>
      <rect x="15" y="9" width="2" height="2" rx="0.5"/>
    </svg>
  );
}

function IconNuke() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <path d="M2 3.5h10M5.5 3.5V2.5a1 1 0 011-1h1a1 1 0 011 1v1M3.5 3.5l.5 8.5a1 1 0 001 1h4a1 1 0 001-1l.5-8.5"/>
      <path d="M5.5 6v4M8.5 6v4"/>
    </svg>
  );
}

function Spinner({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" opacity="0.2"/>
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

// ── Toast System ────────────────────────────────────────────────────────────

let toastId = 0;

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm" id="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`
            ${t.exiting ? "animate-toast-out" : "animate-toast-in"}
            flex items-start gap-3 px-4 py-3 rounded-lg border shadow-xl cursor-pointer
            ${t.type === "error"
              ? "bg-red-950/80 border-red-800/50 text-red-200"
              : t.type === "success"
              ? "bg-emerald-950/80 border-emerald-800/50 text-emerald-200"
              : "bg-zinc-800/80 border-zinc-700/50 text-zinc-200"
            }
            backdrop-blur-md
          `}
          onClick={() => onDismiss(t.id)}
        >
          <span className="mt-0.5 text-base">
            {t.type === "error" ? "✕" : t.type === "success" ? "✓" : "ℹ"}
          </span>
          <p className="text-sm leading-relaxed flex-1">{t.message}</p>
        </div>
      ))}
    </div>
  );
}

// ── Terminal Log ────────────────────────────────────────────────────────────

function TerminalLog({ logs }: { logs: string[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  if (logs.length === 0) return null;

  return (
    <div className="h-32 border-t border-zinc-800 bg-zinc-950 px-4 py-2 font-mono text-[11px] text-zinc-400 overflow-y-auto">
      {logs.map((log, i) => (
        <div key={i} className="mb-0.5 break-all">
          <span className="text-accent-500 mr-2">❯</span>
          {log}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ── Setup Screen ────────────────────────────────────────────────────────────

function SetupScreen({ onConnect, loading, rootMode, onRootModeChange, rootPath, onRootPathChange }: {
  onConnect: () => void;
  loading: boolean;
  rootMode: boolean;
  onRootModeChange: (enabled: boolean) => void;
  rootPath: string;
  onRootPathChange: (path: string) => void;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-8">
      <div className="min-h-full flex flex-col items-center justify-center gap-8 animate-fade-in-up">
        {/* Hero */}
        <div className="flex flex-col items-center gap-6">
          <div className={`
            w-24 h-24 rounded-2xl bg-gradient-to-br from-accent-500/20 to-accent-700/10
            border border-accent-500/20 flex items-center justify-center
            ${loading ? "animate-pulse-glow" : ""}
          `}>
            <span className="text-accent-400">
              <IconUsb />
            </span>
          </div>

          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-zinc-100 to-zinc-400 bg-clip-text text-transparent">
              SocketSweep
            </h1>
            <p className="mx-auto mt-2 text-sm text-zinc-500 max-w-xs leading-relaxed">
              High-performance Android storage analyzer.
              <br />
              <span className="text-zinc-600">Bypasses MTP — direct POSIX scanning.</span>
            </p>
          </div>
        </div>

        <div className="w-full max-w-xs flex flex-col items-center gap-5 text-sm">
          <label className="flex items-center justify-center gap-2.5 text-zinc-300 cursor-pointer">
            <input
              id="scan-as-root"
              type="checkbox"
              checked={rootMode}
              disabled={loading}
              onChange={(event) => onRootModeChange(event.target.checked)}
              className="size-4 shrink-0 accent-accent-500 cursor-pointer"
            />
            <span>Scan with root access (read-only)</span>
          </label>
          {rootMode && (
            <div className="w-full space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <label className="block text-xs text-zinc-400" htmlFor="root-scan-path">Scan location</label>
              <select
                id="root-scan-path"
                value={rootPath}
                disabled={loading}
                onChange={(event) => onRootPathChange(event.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-200"
              >
                <option value="/data">App and user data (/data)</option>
                <option value="/">Internal data and system (/)</option>
                <option value="/sdcard">Shared storage (/sdcard)</option>
              </select>
              <p className="text-xs leading-relaxed text-zinc-400">
                Requires a rooted device. Approve shell access on your phone if prompted.
                Internal scans exclude virtual filesystems and duplicate storage views;
                removable storage is excluded from the whole-device scan.
              </p>
            </div>
          )}
          {/* Connect Button */}
          <button
            id="btn-connect"
            onClick={onConnect}
            disabled={loading}
            className={`
              group relative w-full flex justify-center px-8 py-3 rounded-xl font-semibold text-sm
              transition-all duration-300 cursor-pointer
              ${loading
                ? "bg-zinc-800 text-zinc-500 cursor-wait"
                : "bg-gradient-to-r from-accent-600 to-accent-500 text-white hover:from-accent-500 hover:to-accent-400 hover:shadow-lg hover:shadow-accent-500/20 hover:-translate-y-0.5"
              }
            `}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <Spinner size={16} />
                Connecting…
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <IconUsb />
                Connect Device
              </span>
            )}
          </button>
        </div>

        {/* Requirements hint */}
        <div className="max-w-xs text-center text-xs leading-relaxed text-zinc-500">
          <p>Connect your phone via USB with USB debugging enabled.</p>
        </div>
      </div>
    </div>
  );
}

// ── Scanning Screen ─────────────────────────────────────────────────────────

interface ScanProgress {
  scan_id: string;
  files: number;
  directories: number;
  total_size: number;
  recent_names: string[];
}

function ScanningScreen({ statusText, progress, onCancel, cancelling }: {
  statusText: string; progress: ScanProgress | null; onCancel: () => void; cancelling: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-8 animate-fade-in-up">
      <div className="relative w-32 h-32">
        <div className="absolute inset-0 rounded-full border-2 border-accent-500/20" />
        <svg className="absolute inset-0 animate-spin" style={{ animationDuration: "2s" }} viewBox="0 0 128 128">
          <circle cx="64" cy="64" r="62" fill="none" stroke="url(#scanGrad)" strokeWidth="2.5"
            strokeLinecap="round" strokeDasharray="120 280" />
          <defs>
            <linearGradient id="scanGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="oklch(0.60 0.18 180)" />
              <stop offset="100%" stopColor="oklch(0.60 0.18 180 / 0)" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-16 h-16 rounded-xl bg-accent-500/10 border border-accent-500/20 flex items-center justify-center scan-shimmer">
            <span className="text-accent-400 text-xl">⚡</span>
          </div>
        </div>
      </div>

      <div className="text-center">
        <h2 className="text-lg font-semibold text-zinc-200">Scanning Storage</h2>
        <p className="mt-1 text-sm text-zinc-500 font-mono">{statusText}</p>
        {progress && (
          <div className="mt-4 space-y-2" aria-live="polite">
            <p className="text-sm text-zinc-300">
              {formatNumber(progress.files)} files · {formatNumber(progress.directories)} directories · {formatBytes(progress.total_size)} found
            </p>
            <p className="text-xs text-zinc-500">Partial results — totals may increase</p>
            <ul className="text-xs text-zinc-400 max-w-sm mx-auto space-y-1">
              {progress.recent_names.map((name, index) => <li className="truncate" key={index}>{name}</li>)}
            </ul>
          </div>
        )}
        <button onClick={onCancel} disabled={cancelling}
          className="mt-5 px-4 py-2 rounded-lg text-sm bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">
          {cancelling ? "Cancelling…" : "Cancel scan"}
        </button>
      </div>
    </div>
  );
}

// ── Size Bar ────────────────────────────────────────────────────────────────

function SizeBar({ ratio }: { ratio: number }) {
  const pct = Math.max(0.5, ratio * 100);
  const hue = ratio > 0.8 ? 15 : ratio > 0.5 ? 45 : 180; // red / amber / teal
  return (
    <div className="w-24 h-1.5 rounded-full bg-zinc-800 overflow-hidden flex-shrink-0">
      <div
        className="h-full rounded-full size-bar-inner"
        style={{
          width: `${pct}%`,
          background: `oklch(0.60 0.16 ${hue})`,
        }}
      />
    </div>
  );
}

// ── File Tree Node ──────────────────────────────────────────────────────────

function QueryError({ error, retry }: { error: string; retry: () => void }) {
  return <div role="alert" className="px-4 py-2 text-xs text-red-400">
    {error} <button onClick={retry} className="underline ml-2">Retry</button>
  </div>;
}

function FileTreeNode({ node, scope, parentSize, depth, onNuke, onZoom, expanded, toggle, busy, rootView }: {
  node: ScanNode;
  scope: ScanResponse;
  parentSize: number;
  depth: number;
  onNuke: (nodeId: number) => void;
  onZoom: (nodeId: number) => void;
  expanded: Set<number>;
  toggle: (nodeId: number) => void;
  busy: boolean;
  rootView?: ReturnType<typeof useScanView>;
}) {
  const open = expanded.has(node.id);
  const isDir = node.type === "directory";
  const query = useScanView(scope, node.id, depth > 0 && isDir && open && node.child_count > 0);
  const view = rootView ?? query;
  const page = view.page;
  const ratio = parentSize > 0 ? node.size / parentSize : 0;
  return (
    <div>
      <div className="file-row flex items-center gap-2 px-3 py-1.5 rounded-md group select-none"
        style={{ paddingLeft: `${12 + depth * 16}px` }}>
        <button className="flex items-center gap-2 min-w-0 flex-1 text-left" disabled={!isDir || busy}
          aria-expanded={isDir ? open : undefined} onClick={() => toggle(node.id)}>
          <span className="w-4 flex-shrink-0 flex items-center justify-center">
            {isDir ? <IconChevron open={open} className="text-zinc-500" /> : <span className="w-3" />}
          </span>
          <span className={isDir ? "text-accent-400" : "text-zinc-500"}>{isDir ? <IconFolder /> : <IconFile />}</span>
          <span className={`truncate text-sm ${isDir ? "text-zinc-200 font-medium" : "text-zinc-400"}`}>{node.name}</span>
        </button>
        {isDir && <button disabled={busy} onClick={() => onZoom(node.id)}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 mr-2 px-2 py-1 rounded text-[10px] uppercase font-bold bg-accent-500/10 text-accent-400 border border-accent-500/20">Zoom</button>}
        <SizeBar ratio={ratio} />
        <span className="w-20 text-right text-xs font-mono text-zinc-500 flex-shrink-0">{formatBytes(node.size)}</span>
        {depth > 0 && node.can_delete && <button disabled={busy} onClick={() => onNuke(node.id)}
          title={`Delete ${node.name}`} aria-label={`Delete ${node.name}`}
          className="btn-nuke opacity-0 group-hover:opacity-100 focus:opacity-100 ml-1 px-2 py-1 rounded-md bg-danger-600/20 border border-danger-500/30 text-danger-400 hover:bg-danger-500/30 text-[10px] uppercase font-bold flex items-center gap-1">
          <IconNuke /><span className="hidden sm:inline">Delete</span>
        </button>}
      </div>
      {isDir && open && node.child_count > 0 && <div>
        {!page && !view.error && <p role="status" className="px-4 py-2 text-xs text-zinc-500">Loading entries…</p>}
        {view.error && <QueryError error={view.error} retry={view.retry} />}
        {page?.children.map(child => <FileTreeNode key={child.id} node={child} scope={scope} parentSize={node.size}
          depth={depth + 1} onNuke={onNuke} onZoom={onZoom} expanded={expanded} toggle={toggle} busy={busy} />)}
        {page && (page.previous_cursor || page.next_cursor) && <nav aria-label={`Pages in ${node.name}`}
          className="flex items-center gap-3 py-2 text-xs text-zinc-400" style={{ paddingLeft: `${28 + depth * 16}px` }}>
          <button disabled={!page.previous_cursor || busy} onClick={() => view.go(page.previous_cursor)} className="px-2 py-1 bg-zinc-800 rounded disabled:opacity-30">Previous</button>
          <span>{page.children.length} entries on this page of {formatNumber(node.child_count)}</span>
          <button disabled={!page.next_cursor || busy} onClick={() => view.go(page.next_cursor)} className="px-2 py-1 bg-zinc-800 rounded disabled:opacity-30">Next</button>
        </nav>}
      </div>}
    </div>
  );
}

// ── Stat Card ───────────────────────────────────────────────────────────────

function StatCard({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="glass-card rounded-xl px-5 py-4 flex flex-col gap-1">
      <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider">{label}</span>
      <span className={`text-xl font-bold font-mono tracking-tight ${accent ? "text-accent-400" : "text-zinc-100"}`}>
        {value}
      </span>
    </div>
  );
}

// ── Custom Treemap Content ──────────────────────────────────────────────────

const TreemapContent = (props: any) => {
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

function ResultScreen({
  data,
  onRescan,
  onDisconnect,
  onNuke,
  busy,
}: {
  data: ScanResponse;
  onRescan: () => void;
  onDisconnect: () => void;
  onNuke: (nodeId: number) => void;
  busy: boolean;
}) {
  const [zoomId, setZoomId] = useState(data.root.id);
  const [expanded, setExpanded] = useState(() => new Set([data.root.id]));
  const view = useScanView(data, zoomId, true);
  const page = view.page;
  const onZoom = (id: number) => {
    setExpanded(previous => new Set(previous).add(id));
    setZoomId(id);
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
    <div className="flex flex-col h-full animate-fade-in-up">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 shrink-0">
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

      {data.read_only && (
        <div className="px-6 pt-3 text-xs text-accent-300">
          Root access · Read-only · Deletion disabled
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 px-6 py-4 shrink-0">
        <StatCard label="Total Size" value={formatBytes(data.total_size)} accent />
        <StatCard label="Files" value={formatNumber(data.total_files)} />
        <StatCard label="Directories" value={formatNumber(data.total_dirs)} />
        <StatCard label="Scan Time" value={`${data.scan_time_ms}ms`} />
      </div>

      {/* Treemap */}
      <div className="px-6 mb-4 shrink-0 h-48">
        <div className="glass-card rounded-xl p-2 w-full h-full relative group">
          <ResponsiveContainer width="100%" height="100%">
            <Treemap
              data={treemapData}
              dataKey="size"
              aspectRatio={4 / 3}
              stroke="#fff"
              content={<TreemapContent bgColors={bgColors} />}
              isAnimationActive={false}
              onClick={(e: any) => {
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
      <div className="flex-1 overflow-y-auto px-3 pb-4 min-h-0">
        <div className="flex items-center gap-2 px-3 py-2 mb-1">
          <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex-1">Storage Map</span>
          <span className="text-xs text-zinc-500">
            {[data.errors > 0 ? `${data.errors} access errors` : "", data.skipped > 0 ? `${data.skipped} excluded or duplicate entries` : ""].filter(Boolean).join(" · ")}
          </span>
        </div>
        {!page && !view.error && <p role="status" className="px-3 py-2 text-xs text-zinc-500">Loading storage map…</p>}
        {view.error && <QueryError error={view.error} retry={view.retry} />}
        {page && <FileTreeNode node={page.node} scope={data} parentSize={page.node.size} depth={0}
          onNuke={onNuke} onZoom={onZoom} expanded={expanded} toggle={toggle} busy={busy} rootView={view} />}

      </div>
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [phase, setPhase] = useState<AppPhase>("setup");
  const [rootMode, setRootMode] = useState(false);
  const [rootPath, setRootPath] = useState("/data");
  const [scanData, setScanData] = useState<ScanResponse | null>(null);
  const snapshot = useRef<ScanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const deleting = useRef(false);
  const confirmationRequest = useRef(0);
  const [confirmDelete, setConfirmDelete] = useState<NodeDetail | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const activeScan = useRef<string | null>(null);
  const [statusText, setStatusText] = useState("Initializing…");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const timerRefs = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  // ── Toast helpers ───────────────────────────────────────────────────────
  const pushToast = useCallback((message: string, type: Toast["type"] = "error") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    const timer = setTimeout(() => {
      setToasts((prev) =>
        prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
      );
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 300);
    }, 5000);
    timerRefs.current.set(id, timer);
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = timerRefs.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timerRefs.current.delete(id);
    }
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    );
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 300);
  }, []);

  const requestScan = useCallback(async (path: string): Promise<ScanResponse> => {
    snapshot.current = null;
    confirmationRequest.current += 1;
    setConfirmDelete(null);
    const scanId = crypto.randomUUID();
    activeScan.current = scanId;
    setScanProgress(null);
    setCancelling(false);
    const onProgress = new Channel<ScanProgress>();
    onProgress.onmessage = (progress) => {
      if (activeScan.current === scanId && progress.scan_id === scanId) setScanProgress(progress);
      void invoke("acknowledge_scan_progress", { scanId: progress.scan_id }).catch(() => {
        // The completed/cancelled scan may already have released its channel.
      });
    };
    try {
      const raw = await invoke<string>("run_scan", { path, scanId, onProgress });
      const parsed: ScanResponse = JSON.parse(raw);
      if (parsed.status !== "ok") throw new Error("Scan returned non-ok status");
      return parsed;
    } finally {
      if (activeScan.current === scanId) activeScan.current = null;
      setCancelling(false);
    }
  }, []);

  const handleCancelScan = useCallback(async () => {
    const scanId = activeScan.current;
    if (!scanId) return;
    setCancelling(true);
    try { await invoke("cancel_scan", { scanId }); }
    catch (err) { pushToast(String(err), "error"); setCancelling(false); }
  }, [pushToast]);

  // ── Connect flow ────────────────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    setPhase("connecting");
    const scanPath = rootMode ? rootPath : "/sdcard";
    let initialized = false;
    try {
      setStatusText("Checking ADB…");
      addLog("[ADB] Checking version...");
      const adbVersion = await invoke<string>("check_adb");
      addLog(`[ADB] Found: ${adbVersion}`);

      setStatusText(rootMode ? "Requesting root access…" : "Pushing daemon to device…");
      addLog("[ADB] Killing old daemon, pushing new binary...");
      await invoke<string>("init_daemon", { rootMode });
      initialized = true;
      addLog("[SOCKET] Daemon started and connected via TCP tunnel!");

      setPhase("scanning");
      setStatusText(`Scanning ${scanPath} …`);
      addLog(`[SCAN] Requesting ${scanPath}${rootMode ? " with read-only root access" : ""}...`);
      const parsed = await requestScan(scanPath);

      if (parsed.status !== "ok") throw new Error("Scan returned non-ok status");

      snapshot.current = parsed;
      setScanData(parsed);
      setPhase("result");
      addLog(`[SCAN] Complete! ${parsed.total_files} files, ${parsed.scan_time_ms}ms.`);
      const phases = scanPhaseLog(parsed);
      if (phases) addLog(phases);
    } catch (err: unknown) {
      if (initialized) {
        try { await invoke<string>("stop_daemon"); } catch { /* show the original connection error */ }
      }
      const message = err instanceof Error ? err.message : String(err);
      pushToast(message, message === "Scan cancelled" ? "info" : "error");
      addLog(`${message === "Scan cancelled" ? "[SCAN]" : "[ERROR]"} ${message}`);
      setPhase("setup");
    }
  }, [pushToast, addLog, rootMode, rootPath, requestScan]);

  // ── Rescan ──────────────────────────────────────────────────────────────
  const handleRescan = useCallback(async () => {
    if (!scanData) return;
    const scanPath = scanData.root_path;
    setPhase("scanning");
    setStatusText(`Re-scanning ${scanPath} …`);
    addLog(`[SCAN] Re-scanning ${scanPath}...`);
    try {
      const parsed = await requestScan(scanPath);
      snapshot.current = parsed;
      setScanData(parsed);
      setPhase("result");
      addLog(`[SCAN] Complete! ${parsed.scan_time_ms}ms.`);
      const phases = scanPhaseLog(parsed);
      if (phases) addLog(phases);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(message, message === "Scan cancelled" ? "info" : "error");
      addLog(`${message === "Scan cancelled" ? "[SCAN]" : "[ERROR]"} ${message}`);
      // The failed generation is not an authoritative deletion root. Clear
      // old results rather than offering actions backed by an invalid scan.
      try { await invoke("stop_daemon"); } catch { /* retain the scan error */ }
      setScanData(null);
      setPhase("setup");
    }
  }, [pushToast, addLog, scanData, requestScan]);

  // ── Disconnect ──────────────────────────────────────────────────────────
  const handleDisconnect = useCallback(async () => {
    snapshot.current = null;
    confirmationRequest.current += 1;
    setConfirmDelete(null);
    addLog("[SOCKET] Disconnecting daemon...");
    try {
      await invoke<string>("stop_daemon");
      pushToast("Daemon stopped", "info");
      addLog("[SOCKET] Daemon successfully shut down.");
    } catch {
      addLog("[SOCKET] Daemon was already stopped.");
    }
    setScanData(null);
    setPhase("setup");
  }, [pushToast, addLog]);

  // Resolve confirmation details separately; destructive IPC accepts only IDs.
  const handleNuke = useCallback(async (nodeId: number) => {
    const scope = snapshot.current;
    if (!scope || scope.read_only || deleting.current) return;
    const request = ++confirmationRequest.current;
    try {
      const raw = await invoke<string>("get_scan_node", { generation: scope.generation, revision: scope.revision, nodeId });
      const detail: NodeDetail = JSON.parse(raw);
      if (request === confirmationRequest.current && !deleting.current && sameScan(snapshot.current, scope) && sameScan(detail, scope) && detail.node.id === nodeId && detail.node.can_delete) {
        setConfirmDelete(detail);
      }
    } catch (err) {
      if (request === confirmationRequest.current && sameScan(snapshot.current, scope)) pushToast(String(err), "error");
    }
  }, [pushToast]);

  const executeDelete = useCallback(async () => {
    const target = confirmDelete;
    confirmationRequest.current += 1;
    setConfirmDelete(null);
    if (!target || deleting.current || !sameScan(snapshot.current, target)) return;
    deleting.current = true;
    setBusy(true);
    addLog(`[DELETE] Requesting deletion of ${target.path}...`);
    try {
      const raw = await invoke<string>("delete_item", {
        generation: target.generation, revision: target.revision, nodeId: target.node.id,
      });
      if (!sameScan(snapshot.current, target)) return;
      const result: DeleteResult = JSON.parse(raw);
      if (result.summary.generation !== target.generation || result.summary.revision !== target.revision + 1) {
        throw new Error("Deletion returned an unexpected scan snapshot");
      }
      snapshot.current = result.summary;
      setScanData(result.summary);
      pushToast(`Successfully deleted ${target.node.name}`, "success");
      addLog(`[DELETE] Success: ${result.message}`);
      addLog(`[DELETE] Scan updated (removed ${result.removed.files} files, ${result.removed.dirs} dirs, ${formatBytes(result.removed.size)})`);
    } catch (err: unknown) {
      if (!sameScan(snapshot.current, target)) return;
      const message = err instanceof Error ? err.message : String(err);
      snapshot.current = null;
      setScanData(null);
      setPhase("connecting");
      pushToast(`Delete failed: ${message}. Reconnect and rescan before continuing.`, "error");
      addLog(`[ERROR] Delete failed: ${message}`);
      // The daemon may have partially deleted a directory before reporting an
      // error. Discard its snapshot; never offer a blind retry with stale IDs.
      try { await invoke("stop_daemon"); } catch { /* retain the deletion error */ }
      setPhase("setup");
    } finally {
      deleting.current = false;
      setBusy(false);
    }
  }, [confirmDelete, pushToast, addLog]);

  useEffect(() => {
    const timers = timerRefs.current;
    return () => { timers.forEach((t) => clearTimeout(t)); };
  }, []);

  return (
    <div className="h-screen flex flex-col bg-surface-0 overflow-hidden">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <div className="flex-1 flex flex-col min-h-0">
        {(phase === "setup" || phase === "connecting") && (
          <SetupScreen
            onConnect={handleConnect}
            loading={phase === "connecting"}
            rootMode={rootMode}
            onRootModeChange={setRootMode}
            rootPath={rootPath}
            onRootPathChange={setRootPath}
          />
        )}
        {phase === "scanning" && <ScanningScreen statusText={statusText} progress={scanProgress} onCancel={handleCancelScan} cancelling={cancelling} />}
        {phase === "result" && scanData && (
          <ResultScreen
            key={scanData.generation}
            data={scanData}
            busy={busy}
            onRescan={handleRescan}
            onDisconnect={handleDisconnect}
            onNuke={handleNuke}
          />
        )}
      </div>

      <TerminalLog logs={logs} />

      {/* Custom Confirm Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in-up">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center text-red-500">
                <IconNuke />
              </div>
              <h3 className="text-lg font-bold text-zinc-100">Delete Item?</h3>
            </div>
            <p className="text-sm text-zinc-400 mb-2">
              Are you sure you want to permanently delete:
            </p>
            <p className="text-sm font-mono text-zinc-300 bg-zinc-950 p-2 rounded-lg break-all border border-zinc-800 mb-6">
              {confirmDelete.path}
            </p>
            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={() => { confirmationRequest.current += 1; setConfirmDelete(null); }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeDelete}
                className="px-4 py-2 rounded-lg text-sm font-bold bg-red-600 hover:bg-red-500 text-white transition-colors shadow-lg shadow-red-500/20"
              >
                NUKE IT
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
