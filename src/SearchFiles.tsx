import { useEffect, useRef, useState } from "react";
import { getSearchResults } from "./scanIpc";
import { FILE_TYPE_LABELS } from "./fileTypeSummary";
import type { FileType } from "./fileTypeSummary";
import type { SearchFolder, SearchResponse } from "./searchResults";
import type { ScanNode, ScanResponse } from "./scanView";
import { formatBytes } from "./formatBytes";

const isSelectableFile = (node: ScanNode) => node.type === "file" && node.counted;

export function SearchFiles({ scope, folder, category, busy, onZoom, onNuke }: {
  scope: ScanResponse;
  folder: SearchFolder | null;
  category?: { kind: FileType; clear: () => void };
  busy: boolean;
  onZoom: (id: number) => void;
  onNuke: (id: number, trigger: HTMLButtonElement) => void;
}) {
  const { generation, revision, root_path, read_only, total_size } = scope;
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<{ scope: string; ids: Set<number> } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [entireScan, setEntireScan] = useState(false);
  const fileType = category?.kind ?? null;
  const activeFolder = entireScan ? null : folder;
  const pageScope = JSON.stringify([generation, revision, activeFolder?.id, fileType]);
  const selectionScope = JSON.stringify([pageScope, query]);
  const selected = selection?.scope === selectionScope ? selection.ids : undefined;
  const selectedCount = selected?.size ?? 0;
  const [pagination, setPagination] = useState({ scope: pageScope, offsets: [0] });
  // A revision changes DFS order. Reset synchronously before issuing a request;
  // keep the submitted query, but never carry offsets into a changed snapshot.
  const offsets = pagination.scope === pageScope ? pagination.offsets : [0];
  const skip = offsets[offsets.length - 1];
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([pageScope, root_path, read_only, total_size, query, skip, retry]);
  const [state, setState] = useState<{ key: string; data?: SearchResponse; error?: string }>({ key: "" });
  useEffect(() => {
    if (!query && !fileType) return;
    let current = true;
    void getSearchResults({ generation, revision, root_path, read_only, total_size }, query, skip, activeFolder, fileType).then(data => {
      if (current) setState({ key, data });
    }).catch(error => {
      if (current) setState({ key, error: String(error) });
    });
    return () => { current = false; };
  }, [generation, revision, root_path, read_only, total_size, query, skip, activeFolder, fileType, key]);
  // Hide the previous query/revision/page synchronously, before its effect cleans up.
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;
  const submit = () => {
    if (!input) return;
    if (input !== query) setSelection(null);
    setQuery(input);
    setPagination({ scope: pageScope, offsets: [0] });
  };
  const results = data?.results ?? [];
  const pageFileIds = category ? [] : results.filter(({ node }) => isSelectableFile(node)).map(({ node }) => node.id);
  const pageSelected = pageFileIds.every(id => selected?.has(id));
  const changeScope = () => {
    setSelection(null);
    setEntireScan(value => !value);
    setPagination({ scope: "", offsets: [0] });
  };
  const setFilesSelected = (fileIds: number[], checked: boolean) => {
    setSelection(current => {
      const ids = new Set(current?.scope === selectionScope ? current.ids : undefined);
      for (const id of fileIds) {
        if (checked) ids.add(id); else ids.delete(id);
      }
      return { scope: selectionScope, ids };
    });
  };
  const clearSelection = () => {
    setSelection(null);
    searchInput.current?.focus();
  };
  const range = results.length ? `${skip + 1}–${skip + results.length}` : "0";
  const status = category
    ? data ? `Showing ${range} files` : error ? "Files unavailable" : "Loading files…"
    : data ? `Showing ${range} matches for “${query}”` : error ? "Search unavailable"
      : activeFolder ? "Search names in this folder." : "Search names in the completed scan.";
  return <section aria-label={category ? "Files by type" : "Search"} className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
    {category ? <div className="flex items-center gap-3 py-3">
      <h2 className="text-sm font-semibold text-zinc-200">{FILE_TYPE_LABELS[category.kind]}</h2>
      <button type="button" autoFocus disabled={busy} onClick={category.clear}
        className="text-xs text-accent-400 hover:underline">Clear filter</button>
    </div> : <form className="flex items-center gap-2 py-3" onSubmit={event => { event.preventDefault(); submit(); }}>
      <input id="search-input" ref={searchInput} value={input} disabled={busy}
        onChange={event => setInput(event.target.value)}
        placeholder={activeFolder ? "Search names in this folder" : "Search names in this scan"}
        className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200" />
      <button type="submit" id="search-submit" disabled={busy || !input}
        className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 border border-zinc-700/50 disabled:text-zinc-600">Search</button>
    </form>}
    {folder && <div className="flex flex-wrap items-center gap-2 pb-3 text-xs text-zinc-400">
      <span className="min-w-0 break-all">{activeFolder ? "Folder: " + activeFolder.name : "Entire scan"}</span>
      <button type="button" disabled={busy} onClick={changeScope} className="shrink-0 text-accent-400 hover:underline">
        {activeFolder ? "Search entire scan" : "Search this folder"}
      </button>
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
        <p role="status" className="break-all">{status}</p>
        {!category && <span id="search-selection-count" role="status" className={selectedCount ? "text-accent-300" : "sr-only"}>
          {selectedCount === 1 ? "1 file selected" : selectedCount > 1 ? `${selectedCount.toLocaleString("en-US")} files selected` : ""}
        </span>}
        {pageFileIds.length > 0 && <button type="button" disabled={busy}
          onClick={() => setFilesSelected(pageFileIds, !pageSelected)}
          className="text-accent-400 hover:underline">{pageSelected ? "Deselect this page" : "Select this page"}</button>}
        {selectedCount > 0 && <button type="button" disabled={busy} onClick={clearSelection}
          className="text-accent-400 hover:underline">Clear selection</button>}
      </div>
      <div className="flex gap-2 shrink-0 text-xs">
        <button disabled={busy || !data || skip === 0} onClick={() => setPagination({ scope: pageScope, offsets: offsets.slice(0, -1) })}
          className="text-zinc-300 hover:underline disabled:text-zinc-600">Previous</button>
        <button disabled={busy || !data?.has_more} onClick={() => setPagination({ scope: pageScope, offsets: [...offsets, skip + results.length] })}
          className="text-zinc-300 hover:underline disabled:text-zinc-600">Next</button>
      </div>
    </div>
    {error && <div role="alert" className="text-xs text-red-400 py-2">{error} <button onClick={() => setRetry(value => value + 1)} className="underline">Retry</button></div>}
    {data && results.length === 0 && <p className="text-sm text-zinc-400 py-4">
      {category ? "No files of this type in the scan." : `No matching names in this ${activeFolder ? "folder" : "scan"}.`}
    </p>}
    <ol className="divide-y divide-zinc-800/80">
      {results.map(({ node, path }) => <li key={node.id} className="search-result-row flex items-center gap-3 py-3">
        {!category && <div className="w-4 shrink-0">
          {isSelectableFile(node) && <input type="checkbox" disabled={busy}
            aria-label={`Select ${node.name}`} checked={selected?.has(node.id) ?? false}
            onChange={event => setFilesSelected([node.id], event.currentTarget.checked)}
            className="block size-4 accent-accent-500 cursor-pointer" />}
        </div>}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-zinc-200 whitespace-pre-wrap break-all">{node.name}</p>
          <p className="text-xs text-zinc-500 font-mono whitespace-pre-wrap break-all" dir="auto">{path}</p>
        </div>
        <span className="text-xs text-zinc-300 font-mono shrink-0">{node.counted ? formatBytes(node.size) : "—"}</span>
        <div className="flex flex-col gap-2 shrink-0 text-xs">
          <button disabled={busy || node.parent_id === null}
            onClick={() => onZoom(node.type === "directory" ? node.id : node.parent_id!)}
            className="text-accent-400 hover:underline">Show folder</button>
          <button aria-label={`Delete ${node.name}`} disabled={busy || !node.can_delete} onClick={event => onNuke(node.id, event.currentTarget)}
            className="text-red-400 hover:underline disabled:text-zinc-600">Delete</button>
        </div>
      </li>)}
    </ol>
  </section>;
}
