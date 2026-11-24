import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import type { Range } from "@tanstack/react-virtual";
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

export function QueryError({ error, retry }: { error: string; retry: (trigger: HTMLButtonElement) => void }) {
  return <div role="alert" className="px-4 py-2 text-xs text-red-400">
    {error} <button data-page-action="retry" onClick={event => retry(event.currentTarget)} className="underline ml-2">Retry</button>
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

type DirectoryView = ReturnType<typeof useScanView>;
type RegisterView = (key: string, view: DirectoryView) => () => void;

interface TreeProps {
  node: ScanNode;
  scope: ScanResponse;
  parentSize: number;
  depth: number;
  onNuke: (nodeId: number, trigger: HTMLButtonElement) => void;
  onExport: (nodeId: number, name: string, size: number) => void;
  onZoom: (nodeId: number) => void;
  expanded: Set<number>;
  toggle: (nodeId: number) => void;
  busy: boolean;
  rootView?: DirectoryView;
}

interface NodeRow {
  kind: "node";
  key: string;
  node: ScanNode;
  depth: number;
  parentSize: number;
  loading: boolean;
}
interface DetailRow {
  kind: "detail";
  key: string;
  node: ScanNode;
  depth: number;
  view?: DirectoryView;
}
type TreeRow = NodeRow | DetailRow;

// Only directories own query hooks. File rows are lightweight records until
// they enter the viewport; scrolling never tears down a directory request.
function DirectoryQuery({ node, scope, expanded, register, rootView }: {
  node: ScanNode;
  scope: ScanResponse;
  expanded: Set<number>;
  register: RegisterView;
  rootView?: DirectoryView;
}) {
  const open = expanded.has(node.id);
  const query = useScanView(scope, node.id, !rootView && open && node.child_count > 0);
  const { page, error, go, retry, request } = rootView ?? query;
  const key = viewKey(scope, node.id, null);
  useLayoutEffect(() => register(key, { page, error, go, retry, request }), [register, key, page, error, go, retry, request]);
  return open ? page?.children.filter(child => child.type === "directory").map(child =>
    <DirectoryQuery key={child.id} node={child} scope={scope} expanded={expanded} register={register} />) : null;
}

function FileRow({ row, open, busy, active, onNuke, onExport, onZoom, toggle }: {
  row: NodeRow;
  open: boolean;
  busy: boolean;
  active: boolean;
  onNuke: TreeProps["onNuke"];
  onExport: TreeProps["onExport"];
  onZoom: TreeProps["onZoom"];
  toggle: TreeProps["toggle"];
}) {
  const { node, depth, parentSize, loading } = row;
  const isDir = node.type === "directory";
  const label = <>
    <span className="w-4 flex-shrink-0 flex items-center justify-center">
      {isDir ? <IconChevron open={open} className="text-zinc-500" /> : <span className="w-3" />}
    </span>
    <span className={isDir ? "text-accent-400" : "text-zinc-500"}>{isDir ? <IconFolder /> : <IconFile />}</span>
    <span className={`truncate text-sm ${isDir ? "text-zinc-200 font-medium" : "text-zinc-400"}`}>{node.name}</span>
  </>;
  return <div className="file-row h-10 flex items-center gap-2 px-3 py-1.5 rounded-md group select-none"
    style={{ paddingLeft: `${12 + depth * 16}px` }}>
    {isDir ? <button className="flex items-center gap-2 min-w-0 flex-1 text-left" disabled={busy}
      tabIndex={active ? 0 : -1} aria-expanded={open} aria-busy={loading} onClick={() => toggle(node.id)}>{label}</button>
      : <span className="flex items-center gap-2 min-w-0 flex-1 text-left">{label}</span>}
    {isDir && <button disabled={busy} tabIndex={active ? 0 : -1} onClick={() => onZoom(node.id)}
      className="opacity-0 group-hover:opacity-100 focus:opacity-100 mr-2 px-2 py-1 rounded text-[10px] uppercase font-bold bg-accent-500/10 text-accent-400 border border-accent-500/20">Zoom</button>}
    <SizeBar ratio={parentSize > 0 ? node.size / parentSize : 0} />
    <span className="w-20 text-right text-xs font-mono text-zinc-500 flex-shrink-0">{formatBytes(node.size)}</span>
    {!isDir && depth > 0 && <button disabled={busy} tabIndex={active ? 0 : -1} onClick={() => onExport(node.id, node.name, node.size)}
      title={`Save ${node.name}`} aria-label={`Save ${node.name}`}
      className="opacity-0 group-hover:opacity-100 focus:opacity-100 ml-1 px-2 py-1 rounded-md bg-accent-500/10 border border-accent-500/20 text-accent-400 text-[10px] uppercase font-bold flex items-center gap-1">
      <span className="hidden sm:inline">Save</span>
    </button>}
    {depth > 0 && node.can_delete && <button disabled={busy} tabIndex={active ? 0 : -1} onClick={event => onNuke(node.id, event.currentTarget)}
      title={`Delete ${node.name}`} aria-label={`Delete ${node.name}`}
      className="btn-nuke opacity-0 group-hover:opacity-100 focus:opacity-100 ml-1 px-2 py-1 rounded-md bg-danger-600/20 border border-danger-500/30 text-danger-400 hover:bg-danger-500/30 text-[10px] uppercase font-bold flex items-center gap-1">
      <IconNuke /><span className="hidden sm:inline">Delete</span>
    </button>}
  </div>;
}

export function FileTreeNode({ node, scope, parentSize, depth, onNuke, onExport, onZoom, expanded, toggle, busy, rootView }: TreeProps) {
  const [views, setViews] = useState(() => new Map<string, DirectoryView>());
  const register = useCallback<RegisterView>((key, view) => {
    setViews(previous => new Map(previous).set(key, view));
    return () => setViews(previous => {
      if (!previous.has(key)) return previous;
      const next = new Map(previous);
      next.delete(key);
      return next;
    });
  }, []);
  const rows = useMemo(() => {
    const result: TreeRow[] = [];
    const visit = (current: ScanNode, level: number, size: number) => {
      const key = viewKey(scope, current.id, null);
      const view = current.id === node.id && rootView ? rootView : views.get(key);
      const open = expanded.has(current.id);
      const loading = open && current.child_count > 0 && !view?.page && !view?.error;
      result.push({ kind: "node", key: `node-${current.id}`, node: current, depth: level, parentSize: size, loading });
      if (current.type !== "directory" || !open || current.child_count === 0) return;
      if (view?.page) {
        for (const child of view.page.children) visit(child, level + 1, current.size);
      }
      if (loading || view?.error || view?.page?.previous_cursor || view?.page?.next_cursor) {
        result.push({ kind: "detail", key: `detail-${key}`, node: current, depth: level, view });
      }
    };
    visit(node, depth, parentSize);
    return result;
  }, [node, scope, parentSize, depth, expanded, views, rootView]);
  const nodeRows = useMemo(() => rows.filter((row): row is NodeRow => row.kind === "node"), [rows]);
  const [activeId, setActiveId] = useState(node.id);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const active = nodeRows.find(row => row.node.id === activeId)?.node.id ?? node.id;
  const pinnedIndex = rows.findIndex(row => row.kind === "node" && row.node.id === active);
  const focusedIndex = rows.findIndex(row => row.key === focusedKey);
  const [tree, setTree] = useState<HTMLDivElement | null>(null);
  const [margin, setMargin] = useState(0);
  const pendingFocus = useRef<number | null>(null);
  const hintId = useId();
  const virtual = rows.length > 1024;
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    return [...new Set([...indexes, pinnedIndex, focusedIndex].filter(index => index >= 0))].sort((a, b) => a - b);
  }, [pinnedIndex, focusedIndex]);
  const getItemKey = useCallback((index: number) => rows[index].key, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: virtual,
    getScrollElement: () => tree?.closest("section") ?? tree?.parentElement ?? null,
    estimateSize: () => 40,
    overscan: 10,
    getItemKey,
    rangeExtractor,
    scrollMargin: margin,
  });
  useLayoutEffect(() => {
    const viewport = tree?.closest("section") ?? tree?.parentElement;
    if (!tree || !viewport) return;
    const update = () => setMargin(tree.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [tree]);
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const element = tree?.querySelector<HTMLElement>(`[data-tree-node="${pendingFocus.current}"]`);
    if (element) {
      element.focus({ preventScroll: virtual });
      pendingFocus.current = null;
    }
  });
  const focusNode = (id: number) => {
    const index = rows.findIndex(row => row.kind === "node" && row.node.id === id);
    if (index < 0) return;
    pendingFocus.current = id;
    setActiveId(id);
    if (virtual) virtualizer.scrollToIndex(index, { align: "auto" });
  };
  const items = virtual ? virtualizer.getVirtualItems() : rows.map((row, index) => ({ key: row.key, index, start: 0 }));
  return <>
    <DirectoryQuery node={node} scope={scope} expanded={expanded} register={register} rootView={rootView} />
    <p id={hintId} className="sr-only">Use arrow keys to move between entries, expand or collapse folders. Home and End move to the first and last entry. Tab reaches actions for the focused entry.</p>
    <div ref={setTree} role="tree" aria-label="Scanned files" aria-describedby={hintId} data-logical-rows={nodeRows.length}
      className="relative" style={virtual ? { height: virtualizer.getTotalSize() } : undefined}>
      {items.map(item => {
        const row = rows[item.index];
        if (!row) return null;
        return <div key={item.key} data-index={item.index} ref={virtual ? virtualizer.measureElement : undefined}
          data-directory-query={row.kind === "detail" ? row.node.id : undefined}
          data-directory-request={row.kind === "detail" ? row.view?.request : undefined}
          data-tree-node={row.kind === "node" ? row.node.id : undefined}
          role={row.kind === "node" ? "treeitem" : undefined}
          aria-level={row.kind === "node" ? row.depth + 1 : undefined}
          aria-label={row.kind === "node" ? `${row.node.name} · ${formatBytes(row.node.size)}` : undefined}
          aria-expanded={row.kind === "node" && row.node.type === "directory" ? expanded.has(row.node.id) : undefined}
          tabIndex={row.kind === "node" ? row.node.id === active ? 0 : -1 : undefined}
          className="focus-visible:outline-2 focus-visible:outline-accent-400 rounded-md"
          style={virtual ? { position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start - margin}px)` } : undefined}
          onFocusCapture={() => {
            setFocusedKey(row.key);
            if (row.kind === "node") setActiveId(row.node.id);
          }}
          onKeyDown={row.kind === "node" ? event => {
            if (busy || event.altKey || event.ctrlKey || event.metaKey) return;
            const index = nodeRows.findIndex(entry => entry.node.id === row.node.id);
            let target: number | undefined;
            switch (event.key) {
              case "ArrowDown": target = nodeRows[index + 1]?.node.id; break;
              case "ArrowUp": target = nodeRows[index - 1]?.node.id; break;
              case "Home": target = nodeRows[0]?.node.id; break;
              case "End": target = nodeRows[nodeRows.length - 1]?.node.id; break;
              case "ArrowRight":
                if (row.node.type === "directory" && !expanded.has(row.node.id)) toggle(row.node.id);
                else if (nodeRows[index + 1]?.node.parent_id === row.node.id) target = nodeRows[index + 1].node.id;
                break;
              case "ArrowLeft":
                if (row.node.type === "directory" && expanded.has(row.node.id)) toggle(row.node.id);
                else target = row.node.parent_id ?? undefined;
                break;
              case "Enter":
              case " ":
                if (event.target !== event.currentTarget || row.node.type !== "directory") return;
                toggle(row.node.id);
                break;
              default: return;
            }
            event.preventDefault();
            if (target !== undefined) focusNode(target);
          } : undefined}>
          {row.kind === "node" ? <FileRow row={row} open={expanded.has(row.node.id)} busy={busy} active={row.node.id === active}
            onNuke={onNuke} onExport={onExport} onZoom={onZoom} toggle={toggle} />
            : row.view?.error ? <QueryError error={row.view.error} retry={row.view.retry} />
            : row.view?.page ? <nav aria-label={`Pages in ${row.node.name}`} className="flex items-center gap-3 py-2 text-xs text-zinc-400"
              style={{ paddingLeft: `${28 + row.depth * 16}px` }}>
              <button data-page-action="previous" disabled={!row.view.page.previous_cursor || busy} onClick={event => row.view?.go(row.view.page!.previous_cursor, event.currentTarget)} className="px-2 py-1 bg-zinc-800 rounded disabled:opacity-30">Previous</button>
              <span>{row.view.page.children.length} entries on this page of {row.node.child_count.toLocaleString("en-US")}</span>
              <button data-page-action="next" disabled={!row.view.page.next_cursor || busy} onClick={event => row.view?.go(row.view.page!.next_cursor, event.currentTarget)} className="px-2 py-1 bg-zinc-800 rounded disabled:opacity-30">Next</button>
            </nav> : <LoadingEntries />}
        </div>;
      })}
    </div>
  </>;
}
