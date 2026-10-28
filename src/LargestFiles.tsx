import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseLargestFiles } from "./largestFilesSummary";
import type { LargestResponse } from "./largestFilesSummary";
import type { ScanResponse } from "./scanView";
import { formatBytes } from "./formatBytes";

export function LargestFiles({ scope, busy, onZoom, onNuke }: {
  scope: ScanResponse;
  busy: boolean;
  onZoom: (id: number) => void;
  onNuke: (id: number) => void;
}) {
  const { generation, revision, root_path, read_only, total_files, total_size } = scope;
  const [limit, setLimit] = useState(25);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([generation, revision, root_path, read_only, total_files, total_size, limit, retry]);
  const [state, setState] = useState<{ key: string; data?: LargestResponse; error?: string }>({ key: "" });
  useEffect(() => {
    let current = true;
    void invoke<string>("get_largest_files", { generation, revision, limit }).then(raw => {
      const data = parseLargestFiles(raw, { generation, revision, root_path, read_only, total_files, total_size }, limit);
      if (current) setState({ key, data });
    }).catch(error => {
      if (current) setState({ key, error: String(error) });
    });
    return () => { current = false; };
  }, [generation, revision, root_path, read_only, total_files, total_size, limit, key]);
  // Hide the previous revision/limit synchronously, before its effect cleans up.
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;
  return <section aria-label="Largest files" className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
    <div className="flex items-center justify-between gap-3 py-3">
      <p role="status" className="text-xs text-zinc-400">{data ? `Showing ${data.files.length} of ${data.total_files.toLocaleString("en-US")} scanned files` : error ? "Largest files unavailable" : "Loading largest files…"}</p>
      <label className="text-xs text-zinc-400 shrink-0">Show <select id="largest-limit" value={limit} disabled={busy}
        onChange={event => setLimit(Number(event.target.value))} className="ml-2 bg-zinc-900 border border-zinc-700 rounded px-2 py-1">
        {[10, 25, 50, 100].map(count => <option key={count} value={count}>{count}</option>)}
      </select></label>
    </div>
    <p className="text-xs text-zinc-500 mb-3">From this scan, across all folders. Rescan to refresh device changes.</p>
    {error && <div role="alert" className="text-xs text-red-400 py-2">{error} <button onClick={() => setRetry(value => value + 1)} className="underline">Retry</button></div>}
    {data?.files.length === 0 && <p className="text-sm text-zinc-400 py-4">No counted files in this scan.</p>}
    <ol className="divide-y divide-zinc-800/80">
      {data?.files.map(({ node, path }) => <li key={node.id} className="largest-file-row flex items-center gap-3 py-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-200 whitespace-pre-wrap break-all">{node.name}</p>
          <p className="text-xs text-zinc-500 font-mono whitespace-pre-wrap break-all" dir="auto">{path}</p>
        </div>
        <span className="text-xs text-zinc-300 font-mono shrink-0">{formatBytes(node.size)}</span>
        <div className="flex flex-col gap-2 shrink-0 text-xs">
          <button disabled={busy || node.parent_id === null} onClick={() => onZoom(node.parent_id!)} className="text-accent-400 hover:underline">Show folder</button>
          <button aria-label={`Delete ${node.name}`} disabled={busy || !node.can_delete} onClick={() => onNuke(node.id)}
            className="text-red-400 hover:underline disabled:text-zinc-600">Delete</button>
        </div>
      </li>)}
    </ol>
  </section>;
}
