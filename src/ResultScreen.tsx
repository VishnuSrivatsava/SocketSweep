import type { SearchFolder } from "./searchResults";
import { useEffect, useRef, useState } from "react";
import { StorageMap } from "./StorageMap";
import { formatBytes } from "./formatBytes";
import type { ScanResponse } from "./scanView";
import { useScanView } from "./useScanView";
import { FileTreeNode, QueryError } from "./FileTree";
import { LargestFiles } from "./LargestFiles";
import { SearchFiles } from "./SearchFiles";
import { FileTypes } from "./FileTypes";
import { AppUsage } from "./AppUsage";
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
  onNuke: (nodeId: number, trigger: HTMLButtonElement) => void;
  busy: boolean;
  deviceSerial: string;
}) {
  const [zoomId, setZoomId] = useState(data.root.id);
  const [expanded, setExpanded] = useState(() => new Set([data.root.id]));
  const [mode, setMode] = useState<"map" | "largest" | "types" | "search" | "apps">("map");
  const [searchFolder, setSearchFolder] = useState<SearchFolder | null>(null);
  const [mapVisible, setMapVisible] = useState(true);
  const mapPanel = useRef<HTMLDivElement>(null);
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

  const breadcrumbs = page?.breadcrumbs ?? [];
  const unreadable = data.unreadable_directories;
  const unreadableCount = unreadable ? unreadable.paths.length + unreadable.omitted : 0;

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

      <div className="flex items-start gap-2 px-4 pb-2 shrink-0">
        <div className="flex flex-1 gap-2 min-w-0 overflow-x-auto [&>button]:shrink-0 [&>button]:whitespace-nowrap" role="group" aria-label="Scan view">
          <button aria-pressed={mode === "map"} disabled={busy} onClick={() => setMode("map")}
            className={`px-3 py-2 rounded-lg text-xs ${mode === "map" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400"}`}>Storage map</button>
          <button aria-pressed={mode === "largest"} disabled={busy} onClick={() => setMode("largest")}
            className={`px-3 py-2 rounded-lg text-xs ${mode === "largest" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400"}`}>Largest files</button>
          <button aria-pressed={mode === "types"} disabled={busy} onClick={() => setMode("types")}
            className={`px-3 py-2 rounded-lg text-xs ${mode === "types" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400"}`}>File types</button>
          <button aria-pressed={mode === "search"} disabled={busy} onClick={() => { setSearchFolder(null); setMode("search"); }}
            className={`px-3 py-2 rounded-lg text-xs ${mode === "search" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400"}`}>Search</button>
          <button aria-pressed={mode === "apps"} disabled={busy} onClick={() => setMode("apps")}
            className={`px-3 py-2 rounded-lg text-xs ${mode === "apps" ? "bg-zinc-700 text-white" : "bg-zinc-900 text-zinc-400"}`}>Package folders</button>
        </div>
        {mode === "map" && (
          <button
            type="button"
            aria-controls="storage-map-panel"
            aria-expanded={mapVisible}
            onClick={event => {
              if (mapVisible && mapPanel.current?.contains(document.activeElement)) {
                event.currentTarget.focus({ preventScroll: true });
              }
              setMapVisible(visible => !visible);
            }}
            className="shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-xs bg-zinc-900 text-zinc-300
              hover:bg-zinc-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-400"
          >
            {mapVisible ? "Hide map" : "Show map"}
          </button>
        )}
      </div>
      {mode === "apps" ? <AppUsage key={data.revision} scope={data} busy={busy} /> : mode === "types" ? <FileTypes scope={data} busy={busy} onZoom={onZoom} onNuke={onNuke} /> : mode === "largest" ? <LargestFiles scope={data} busy={busy} onZoom={onZoom} onNuke={onNuke} /> : mode === "search" ? <SearchFiles key={searchFolder?.id ?? "all"} scope={data} folder={searchFolder} busy={busy} onZoom={onZoom} onNuke={onNuke} /> : <div className={`flex-1 min-h-0 grid gap-3 px-4 pb-3 ${mapVisible
        ? "grid-rows-[7rem_minmax(0,1fr)] md:grid-rows-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
        : "grid-cols-1 grid-rows-1"}`}>
      <div id="storage-map-panel" ref={mapPanel} hidden={!mapVisible} className="min-h-0 min-w-0">
        {mapVisible && <StorageMap page={page} busy={busy} onZoom={onZoom} />}
      </div>

      {/* File tree */}
      <section aria-label="Files and folders" className="glass-card rounded-xl overflow-y-auto px-2 pb-3 min-h-0 min-w-0">
        <div className="flex items-center gap-2 px-3 py-2 mb-1">
          <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex-1">Files and folders</span>
          {page?.node.type === "directory" && page.node.id !== data.root.id && (
            <button
              disabled={busy}
              onClick={() => {
                setSearchFolder({ id: page.node.id, name: page.node.name, path: page.path });
                setMode("search");
              }}
              className="text-xs text-accent-400 hover:underline"
            >Search this folder</button>
          )}
          <span className="text-xs text-zinc-500">
            {[data.errors > 0 ? `${data.errors} access errors` : "", data.skipped > 0 ? `${data.skipped} excluded or duplicate entries` : ""].filter(Boolean).join(" · ")}
          </span>
        </div>
        {unreadable && unreadableCount > 0 && (
          <details className="px-3 pb-2 text-xs text-zinc-400">
            <summary className="cursor-pointer text-amber-300">
              {unreadableCount === 1 ? "1 folder could not be read" : `${unreadableCount.toLocaleString("en-US")} folders could not be read`}
            </summary>
            <ul aria-label="Unreadable folder paths" className="mt-1 max-h-32 overflow-y-auto font-mono">
              {unreadable.paths.map(path => (
                <li key={path} className="py-0.5 whitespace-pre-wrap break-all"><bdi>{path}</bdi></li>
              ))}
            </ul>
            {unreadable.omitted > 0 && <p className="mt-1">Plus {unreadable.omitted.toLocaleString("en-US")} more</p>}
          </details>
        )}
        {!page && !view.error && <p role="status" className="px-3 py-2 text-xs text-zinc-500">Loading storage map…</p>}
        {view.error && <div data-directory-query={zoomId} data-directory-request={view.request}><QueryError error={view.error} retry={view.retry} /></div>}
        {page && <FileTreeNode node={page.node} scope={data} parentSize={page.node.size} depth={0}
          onNuke={onNuke} onZoom={onZoom} expanded={expanded} toggle={toggle} busy={busy} rootView={view} />}

      </section>
      </div>}
    </div>
  );
}

