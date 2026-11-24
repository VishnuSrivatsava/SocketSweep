import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getFileTypes } from "./scanIpc";
import { FILE_TYPES, FILE_TYPE_LABELS } from "./fileTypeSummary";
import type { FileType, FileTypesResponse } from "./fileTypeSummary";
import type { ScanResponse } from "./scanView";
import { formatBytes } from "./formatBytes";
import { SearchFiles } from "./SearchFiles";

export function FileTypes({ scope, busy, onZoom, onNuke }: {
  scope: ScanResponse;
  busy: boolean;
  onZoom: (id: number) => void;
  onNuke: (id: number, trigger: HTMLButtonElement) => void;
}) {
  const { generation, revision, total_files, total_size } = scope;
  const [retry, setRetry] = useState(0);
  const [category, setCategory] = useState<FileType | null>(null);
  const returnFocus = useRef<FileType | null>(null);
  const summary = useRef<HTMLElement>(null);
  const key = JSON.stringify([generation, revision, total_files, total_size, retry]);
  const [state, setState] = useState<{ key: string; data?: FileTypesResponse; error?: string }>({ key: "" });
  useEffect(() => {
    let current = true;
    void getFileTypes({ generation, revision, total_files, total_size }).then(data => {
      if (current) setState({ key, data });
    }).catch(error => {
      if (current) setState({ key, error: String(error) });
    });
    return () => { current = false; };
  }, [generation, revision, total_files, total_size, key]);
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;
  useLayoutEffect(() => {
    if (category || !returnFocus.current) return;
    const button = summary.current?.querySelector<HTMLButtonElement>(`[data-kind="${returnFocus.current}"] button:enabled`);
    (button ?? summary.current)?.focus();
    returnFocus.current = null;
  }, [category]);
  if (category) {
    return <SearchFiles scope={scope} folder={null} busy={busy} onZoom={onZoom} onNuke={onNuke}
      category={{ kind: category, clear: () => { returnFocus.current = category; setCategory(null); } }} />;
  }
  return <section aria-label="File types" ref={summary} tabIndex={-1} className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
    <p role="status" className="text-xs text-zinc-400 py-3">{data ? `${data.total_files.toLocaleString("en-US")} scanned files · ${formatBytes(data.total_size)}` : error ? "File types unavailable" : "Loading file types…"}</p>
    <p className="text-xs text-zinc-500 mb-2 break-all">Scan root: <span className="font-mono">{scope.root_path}</span></p>
    <p className="text-xs text-zinc-500 mb-2">Across all folders in this scan. Grouped by filename extension; file contents are not inspected.</p>
    <p className="text-xs text-zinc-500 mb-3">Scanned data only: {scope.errors.toLocaleString("en-US")} access errors · {scope.skipped.toLocaleString("en-US")} excluded or duplicate entries.</p>
    {error && <div role="alert" className="text-xs text-red-400 py-2">{error} <button disabled={busy} onClick={() => setRetry(value => value + 1)} className="underline disabled:opacity-50">Retry</button></div>}
    {data?.total_files === 0 && <p className="text-sm text-zinc-400 py-3">No counted files in this scan.</p>}
    <table aria-busy={!data && !error} className="w-full text-xs text-left">
      <caption className="sr-only">File-type storage breakdown</caption>
      <thead className="text-zinc-500"><tr><th scope="col" className="py-2">Type</th><th scope="col" className="text-right px-2">Files</th><th scope="col" className="text-right px-2">Size</th><th scope="col" className="text-right pl-2">Share</th></tr></thead>
      <tbody className="divide-y divide-zinc-800/80">
        {FILE_TYPES.map((kind, index) => {
          const category = data?.categories[index];
          const percent = data && category ? (data.total_size > 0 ? category.size / data.total_size * 100 : 0) : undefined;
          return <tr key={kind} className="file-type-row" data-kind={kind}>
            <th scope="row" className="py-3 font-medium text-zinc-200">
              <button type="button" aria-label={`Browse ${FILE_TYPE_LABELS[kind]}`} disabled={busy || !category}
                onClick={() => setCategory(kind)}
                className="text-left text-accent-400 hover:underline disabled:text-zinc-400 disabled:no-underline">
                {FILE_TYPE_LABELS[kind]}
              </button>
            </th>
            <td className="text-right px-2 font-mono text-zinc-400">{category ? category.files.toLocaleString("en-US") : "—"}</td>
            <td className="text-right px-2 font-mono text-zinc-300">{category ? formatBytes(category.size) : "—"}</td>
            <td className="pl-2"><div className="flex items-center justify-end gap-2">
              <div aria-hidden="true" className="hidden sm:block w-16 h-1.5 rounded-full bg-zinc-800 overflow-hidden"><div className="h-full bg-accent-500" style={{ width: `${percent ?? 0}%` }} /></div>
              <span className="text-right font-mono text-zinc-400 w-12">{percent !== undefined ? `${percent.toFixed(1)}%` : "—"}</span>
            </div></td>
          </tr>;
        })}
      </tbody>
      <tfoot className="border-t border-zinc-700 text-zinc-200"><tr><th scope="row" className="py-3 font-medium">Total</th><td className="text-right px-2 font-mono">{data ? data.total_files.toLocaleString("en-US") : "—"}</td><td className="text-right px-2 font-mono">{data ? formatBytes(data.total_size) : "—"}</td><td className="text-right pl-2 font-mono">{data ? (data.total_size > 0 ? "100.0%" : "0.0%") : "—"}</td></tr></tfoot>
    </table>
  </section>;
}
