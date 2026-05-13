import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Treemap, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import "./App.css";

// ── Types ───────────────────────────────────────────────────────────────────

interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  children?: FileNode[];
}

interface ScanResponse {
  status: string;
  scan_time_ms: number;
  total_files: number;
  total_dirs: number;
  total_size: number;
  errors: number;
  tree: FileNode;
}

interface Toast {
  id: number;
  message: string;
  type: "error" | "success" | "info";
  exiting?: boolean;
}

type AppPhase = "setup" | "connecting" | "scanning" | "result";

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function findNodeByPath(root: FileNode, targetPath: string): FileNode | null {
  if (root.path === targetPath) return root;
  if (!root.children) return null;
  for (const child of root.children) {
    if (targetPath.startsWith(child.path)) {
      const found = findNodeByPath(child, targetPath);
      if (found) return found;
    }
  }
  return null;
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

function SetupScreen({ onConnect, loading }: { onConnect: () => void; loading: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-8 animate-fade-in-up">
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
          <p className="mt-2 text-sm text-zinc-500 max-w-xs leading-relaxed">
            High-performance Android storage analyzer.
            <br />
            <span className="text-zinc-600">Bypasses MTP — direct POSIX scanning.</span>
          </p>
        </div>
      </div>

      {/* Connect Button */}
      <button
        id="btn-connect"
        onClick={onConnect}
        disabled={loading}
        className={`
          group relative px-8 py-3 rounded-xl font-semibold text-sm
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

      {/* Requirements hint */}
      <div className="flex flex-col items-center gap-1.5 text-xs text-zinc-600">
        <p>• Android device connected via USB</p>
        <p>• USB Debugging enabled in Developer Options</p>
        <p>• ADB installed and in your PATH</p>
      </div>
    </div>
  );
}

// ── Scanning Screen ─────────────────────────────────────────────────────────

function ScanningScreen({ statusText }: { statusText: string }) {
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

function FileTreeNode({
  node,
  parentSize,
  depth,
  onNuke,
  onZoom,
}: {
  node: FileNode;
  parentSize: number;
  depth: number;
  onNuke: (path: string, name: string) => void;
  onZoom: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const isDir = node.type === "directory";
  const ratio = parentSize > 0 ? node.size / parentSize : 0;

  return (
    <div className="animate-fade-in-up" style={{ animationDelay: `${depth * 20}ms` }}>
      <div
        className={`
          file-row flex items-center gap-2 px-3 py-1.5 rounded-md cursor-pointer
          group select-none
        `}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => {
          if (isDir) setOpen(!open);
        }}
      >
        <span className="w-4 flex-shrink-0 flex items-center justify-center">
          {isDir ? (
            <IconChevron open={open} className="text-zinc-500" />
          ) : (
            <span className="w-3" />
          )}
        </span>

        <span className={isDir ? "text-accent-400" : "text-zinc-500"}>
          {isDir ? <IconFolder /> : <IconFile />}
        </span>

        <span className={`flex-1 truncate text-sm ${isDir ? "text-zinc-200 font-medium" : "text-zinc-400"}`}>
          {node.name}
        </span>

        {/* Action Buttons */}
        {isDir && (
           <button
             className="opacity-0 group-hover:opacity-100 mr-2 px-2 py-1 rounded text-[10px] uppercase font-bold tracking-wider bg-accent-500/10 text-accent-400 border border-accent-500/20 hover:bg-accent-500/30"
             onClick={(e) => { e.stopPropagation(); onZoom(node.path); }}
           >
             Zoom
           </button>
        )}

        <SizeBar ratio={ratio} />

        <span className="w-20 text-right text-xs font-mono text-zinc-500 flex-shrink-0">
          {formatBytes(node.size)}
        </span>

        <button
          className="btn-nuke opacity-0 group-hover:opacity-100 ml-1 px-2 py-1 rounded-md
            bg-danger-600/20 border border-danger-500/30 text-danger-400
            hover:bg-danger-500/30 hover:text-danger-400 text-[10px] uppercase font-bold tracking-wider flex items-center gap-1
            cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            onNuke(node.path, node.name);
          }}
          title={`Delete ${node.name}`}
        >
          <IconNuke />
          <span className="hidden sm:inline">Delete</span>
        </button>
      </div>

      {isDir && open && node.children && (
        <div>
          {node.children.map((child, i) => (
            <FileTreeNode
              key={`${child.path}-${i}`}
              node={child}
              parentSize={node.size}
              depth={depth + 1}
              onNuke={onNuke}
              onZoom={onZoom}
            />
          ))}
        </div>
      )}
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
}: {
  data: ScanResponse;
  onRescan: () => void;
  onDisconnect: () => void;
  onNuke: (path: string, name: string) => void;
}) {
  const [zoomPath, setZoomPath] = useState<string>(data.tree.path);
  
  // Find node to render based on zoom
  const renderNode = findNodeByPath(data.tree, zoomPath) || data.tree;

  const bgColors = [
    "#0d9488", "#0284c7", "#4f46e5", "#7c3aed", 
    "#c026d3", "#e11d48", "#ea580c", "#ca8a04",
  ];

  // Flatten immediate children for a clean 1-level treemap
  const treemapData = (renderNode.children || [])
    .filter(c => c.size > 0)
    .map(c => ({
      name: c.name,
      size: c.size,
      path: c.path,
    }));

  return (
    <div className="flex flex-col h-full animate-fade-in-up">
      {/* Top bar */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <h1 className="text-base font-semibold text-zinc-200 tracking-tight">SocketSweep</h1>
          <span className="text-xs text-zinc-600 font-mono">
            {zoomPath === data.tree.path ? `/ ${data.tree.name}` : `/ ${renderNode.name}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {zoomPath !== data.tree.path && (
            <button
              onClick={() => setZoomPath(data.tree.path)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            >
              ← Back to Root
            </button>
          )}
          <button
            id="btn-rescan"
            onClick={onRescan}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300
              hover:bg-zinc-700 hover:text-zinc-100 border border-zinc-700/50"
          >
            ↻ Rescan
          </button>
          <button
            id="btn-disconnect"
            onClick={onDisconnect}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-400
              hover:bg-red-950/50 hover:text-red-400 border border-zinc-700/50"
          >
            Disconnect
          </button>
        </div>
      </header>

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
                if (e && e.path) setZoomPath(e.path);
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
                        <p className="text-zinc-600 mt-1">Click to Zoom</p>
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
          <span className="text-xs text-zinc-600">{data.errors > 0 ? `${data.errors} access errors skipped` : ""}</span>
        </div>
        <FileTreeNode
          node={renderNode}
          parentSize={renderNode.size}
          depth={0}
          onNuke={onNuke}
          onZoom={setZoomPath}
        />
      </div>
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [phase, setPhase] = useState<AppPhase>("setup");
  const [scanData, setScanData] = useState<ScanResponse | null>(null);
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

  // ── Connect flow ────────────────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    setPhase("connecting");
    try {
      setStatusText("Checking ADB…");
      addLog("[ADB] Checking version...");
      const adbVersion = await invoke<string>("check_adb");
      addLog(`[ADB] Found: ${adbVersion}`);

      setStatusText("Pushing daemon to device…");
      addLog("[ADB] Killing old daemon, pushing new binary...");
      await invoke<string>("init_daemon");
      addLog("[SOCKET] Daemon started and connected via TCP tunnel!");

      setPhase("scanning");
      setStatusText("Scanning /sdcard …");
      addLog("[SCAN] Requesting /sdcard (Fast POSIX traversal)...");
      const raw = await invoke<string>("run_scan", { path: "/sdcard" });
      const parsed: ScanResponse = JSON.parse(raw);

      if (parsed.status !== "ok") throw new Error("Scan returned non-ok status");

      setScanData(parsed);
      setPhase("result");
      addLog(`[SCAN] Complete! ${parsed.total_files} files, ${parsed.scan_time_ms}ms.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(message, "error");
      addLog(`[ERROR] ${message}`);
      setPhase("setup");
    }
  }, [pushToast, addLog]);

  // ── Rescan ──────────────────────────────────────────────────────────────
  const handleRescan = useCallback(async () => {
    setPhase("scanning");
    setStatusText("Re-scanning /sdcard …");
    addLog("[SCAN] Re-scanning /sdcard...");
    try {
      const raw = await invoke<string>("run_scan", { path: "/sdcard" });
      const parsed: ScanResponse = JSON.parse(raw);
      setScanData(parsed);
      setPhase("result");
      addLog(`[SCAN] Complete! ${parsed.scan_time_ms}ms.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(message, "error");
      addLog(`[ERROR] ${message}`);
      setPhase("result");
    }
  }, [pushToast, addLog]);

  // ── Disconnect ──────────────────────────────────────────────────────────
  const handleDisconnect = useCallback(async () => {
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

  const [confirmDelete, setConfirmDelete] = useState<{path: string, name: string} | null>(null);

  // ── Nuke (Delete) ───────────────────────────────────────────────────────
  const handleNuke = useCallback((path: string, name: string) => {
    setConfirmDelete({ path, name });
  }, []);

  const executeDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const { path, name } = confirmDelete;
    setConfirmDelete(null);

    addLog(`[DELETE] Requesting deletion of ${path}...`);
    try {
      const raw = await invoke<string>("delete_item", { path });
      const parsed = JSON.parse(raw);
      if (parsed.status === "ok") {
        pushToast(`Successfully deleted ${name}`, "success");
        addLog(`[DELETE] Success: ${parsed.message}`);
        handleRescan();
      } else {
        throw new Error(parsed.message || "Unknown error");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(`Delete failed: ${message}`, "error");
      addLog(`[ERROR] Delete failed: ${message}`);
    }
  }, [confirmDelete, pushToast, addLog, handleRescan]);

  useEffect(() => {
    const timers = timerRefs.current;
    return () => { timers.forEach((t) => clearTimeout(t)); };
  }, []);

  return (
    <div className="h-screen flex flex-col bg-surface-0 overflow-hidden">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      <div className="flex-1 flex flex-col min-h-0">
        {phase === "setup" && <SetupScreen onConnect={handleConnect} loading={false} />}
        {phase === "connecting" && <SetupScreen onConnect={handleConnect} loading={true} />}
        {phase === "scanning" && <ScanningScreen statusText={statusText} />}
        {phase === "result" && scanData && (
          <ResultScreen
            data={scanData}
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
              {confirmDelete.name}
            </p>
            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
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
