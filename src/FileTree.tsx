import { useEffect, useState } from "react";
import { formatBytes } from "./formatBytes";
import { viewKey } from "./scanView";
import type { ScanNode, ScanResponse } from "./scanView";
import { useScanView } from "./useScanView";
import { IconNuke } from "./Icons";

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

export function QueryError({ error, retry }: { error: string; retry: () => void }) {
  return <div role="alert" className="px-4 py-2 text-xs text-red-400">
    {error} <button onClick={retry} className="underline ml-2">Retry</button>
  </div>;
}

function LoadingEntries() {
  const [visible, setVisible] = useState(false);
  // Delay only the status, never the query or its result. Each pending mount
  // owns its timer; completion, collapse and scope changes cancel it.
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return visible ? <p role="status" className="px-4 py-2 text-xs text-zinc-500">Loading entries…</p> : null;
}

export function FileTreeNode({ node, scope, parentSize, depth, onNuke, onZoom, expanded, toggle, busy, rootView }: {
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
  const loading = open && node.child_count > 0 && !page && !view.error;
  const ratio = parentSize > 0 ? node.size / parentSize : 0;
  const label = <>
          <span className="w-4 flex-shrink-0 flex items-center justify-center">
            {isDir ? <IconChevron open={open} className="text-zinc-500" /> : <span className="w-3" />}
          </span>
          <span className={isDir ? "text-accent-400" : "text-zinc-500"}>{isDir ? <IconFolder /> : <IconFile />}</span>
          <span className={`truncate text-sm ${isDir ? "text-zinc-200 font-medium" : "text-zinc-400"}`}>{node.name}</span>
  </>;
  return (
    <div>
      <div className="file-row flex items-center gap-2 px-3 py-1.5 rounded-md group select-none"
        style={{ paddingLeft: `${12 + depth * 16}px` }}>
        {isDir ? <button className="flex items-center gap-2 min-w-0 flex-1 text-left" disabled={busy}
          aria-expanded={open} aria-busy={loading} onClick={() => toggle(node.id)}>{label}</button>
          : <span className="flex items-center gap-2 min-w-0 flex-1 text-left">{label}</span>}
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
        {loading && <LoadingEntries key={viewKey(scope, node.id, null)} />}
        {view.error && <QueryError error={view.error} retry={view.retry} />}
        {page?.children.map(child => <FileTreeNode key={child.id} node={child} scope={scope} parentSize={node.size}
          depth={depth + 1} onNuke={onNuke} onZoom={onZoom} expanded={expanded} toggle={toggle} busy={busy} />)}
        {page && (page.previous_cursor || page.next_cursor) && <nav aria-label={`Pages in ${node.name}`}
          className="flex items-center gap-3 py-2 text-xs text-zinc-400" style={{ paddingLeft: `${28 + depth * 16}px` }}>
          <button disabled={!page.previous_cursor || busy} onClick={() => view.go(page.previous_cursor)} className="px-2 py-1 bg-zinc-800 rounded disabled:opacity-30">Previous</button>
          <span>{page.children.length} entries on this page of {node.child_count.toLocaleString("en-US")}</span>
          <button disabled={!page.next_cursor || busy} onClick={() => view.go(page.next_cursor)} className="px-2 py-1 bg-zinc-800 rounded disabled:opacity-30">Next</button>
        </nav>}
      </div>}
    </div>
  );
}

