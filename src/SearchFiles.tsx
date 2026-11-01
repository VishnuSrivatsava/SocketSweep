import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseSearchResults } from "./searchResults";
import type { SearchResponse } from "./searchResults";
import type { ScanResponse } from "./scanView";
import { formatBytes } from "./formatBytes";

export function SearchFiles({ scope, busy, onZoom, onNuke }: {
  scope: ScanResponse;
  busy: boolean;
  onZoom: (id: number) => void;
  onNuke: (id: number) => void;
}) {
  const { generation, revision, root_path, read_only, total_size } = scope;
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const pageScope = JSON.stringify([generation, revision]);
  const [pagination, setPagination] = useState({ scope: pageScope, offsets: [0] });
  // A revision changes DFS order. Reset synchronously before issuing a request;
  // keep the submitted query, but never carry offsets into a changed snapshot.
  const offsets = pagination.scope === pageScope ? pagination.offsets : [0];
  const skip = offsets[offsets.length - 1];
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([generation, revision, root_path, read_only, total_size, query, skip, retry]);
  const [state, setState] = useState<{ key: string; data?: SearchResponse; error?: string }>({ key: "" });
  useEffect(() => {
    if (!query) return;
    let current = true;
    void invoke<string>("get_search_results", { generation, revision, query, skip }).then(raw => {
      const data = parseSearchResults(raw, { generation, revision, root_path, read_only, total_size }, query, skip);
      if (current) setState({ key, data });
    }).catch(error => {
      if (current) setState({ key, error: String(error) });
    });
    return () => { current = false; };
  }, [generation, revision, root_path, read_only, total_size, query, skip, retry, key]);
  // Hide the previous query/revision/page synchronously, before its effect cleans up.
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;
  const submit = () => {
    if (!input) return;
    setQuery(input);
    setPagination({ scope: pageScope, offsets: [0] });
  };
  const results = data?.results ?? [];
  return <section aria-label="Search" className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
    <form className="flex items-center gap-2 py-3" onSubmit={event => { event.preventDefault(); submit(); }}>
      <input id="search-input" value={input} disabled={busy}
        onChange={event => setInput(event.target.value)}
        placeholder="Search names in this scan"
        className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200" />
      <button type="submit" id="search-submit" disabled={busy || !input}
        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 border border-zinc-700/50 disabled:text-zinc-600">Search</button>
    </form>
    <div className="flex items-center justify-between gap-3 pb-3">
      <p role="status" className="text-xs text-zinc-400">
        {data ? `Showing ${results.length ? `${skip + 1}–${skip + results.length}` : "0"} matches for “${query}”` : error ? "Search unavailable" : "Search names in the completed scan."}
      </p>
      <div className="flex gap-2 shrink-0 text-xs">
        <button disabled={busy || !data || skip === 0} onClick={() => setPagination({ scope: pageScope, offsets: offsets.slice(0, -1) })}
          className="text-zinc-300 hover:underline disabled:text-zinc-600">Previous</button>
        <button disabled={busy || !data?.has_more} onClick={() => setPagination({ scope: pageScope, offsets: [...offsets, skip + results.length] })}
          className="text-zinc-300 hover:underline disabled:text-zinc-600">Next</button>
      </div>
    </div>
    {error && <div role="alert" className="text-xs text-red-400 py-2">{error} <button onClick={() => setRetry(value => value + 1)} className="underline">Retry</button></div>}
    {data && results.length === 0 && <p className="text-sm text-zinc-400 py-4">No matching names in this scan.</p>}
    <ol className="divide-y divide-zinc-800/80">
      {results.map(({ node, path }) => <li key={node.id} className="search-result-row flex items-center gap-3 py-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-200 whitespace-pre-wrap break-all">{node.name}</p>
          <p className="text-xs text-zinc-500 font-mono whitespace-pre-wrap break-all" dir="auto">{path}</p>
        </div>
        <span className="text-xs text-zinc-300 font-mono shrink-0">{node.counted ? formatBytes(node.size) : "—"}</span>
        <div className="flex flex-col gap-2 shrink-0 text-xs">
          <button disabled={busy || node.parent_id === null}
            onClick={() => onZoom(node.type === "directory" ? node.id : node.parent_id!)}
            className="text-accent-400 hover:underline">Show folder</button>
          <button aria-label={`Delete ${node.name}`} disabled={busy || !node.can_delete} onClick={() => onNuke(node.id)}
            className="text-red-400 hover:underline disabled:text-zinc-600">Delete</button>
        </div>
      </li>)}
    </ol>
  </section>;
}
