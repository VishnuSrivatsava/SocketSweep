import { useEffect, useState } from "react";
import { getAppUsage } from "./scanIpc";
import type { AppUsageResponse } from "./appUsageSummary";
import type { ScanResponse } from "./scanView";
import { formatBytes } from "./formatBytes";

export function AppUsage({ scope, busy }: { scope: ScanResponse; busy: boolean }) {
  const { generation, revision, total_size, errors, skipped } = scope;
  const [skip, setSkip] = useState(0);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([generation, revision, total_size, errors, skipped, skip, retry]);
  const [state, setState] = useState<{ key: string; data?: AppUsageResponse; error?: string }>({ key: "" });
  useEffect(() => {
    let current = true;
    void getAppUsage({ generation, revision, total_size, errors, skipped }, skip).then(data => {
      if (current) setState({ key, data });
    }).catch(error => {
      if (current) setState({ key, error: String(error) });
    });
    return () => { current = false; };
  }, [generation, revision, total_size, errors, skipped, skip, key]);
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;
  return <section aria-label="Package-folder usage" className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
    <p className="text-xs text-zinc-400 pt-3">Values cover scanned package folders. Full app totals remain unknown.
      Missing and unreadable locations remain unknown.</p>
    <p className="text-xs text-zinc-500 py-2">Package IDs come from folder names and may include leftovers from uninstalled apps.</p>
    <p className="text-xs text-zinc-500 break-all">Scan root: <span className="font-mono">{scope.root_path}</span></p>
    <p className="text-xs text-zinc-500 py-2">{errors.toLocaleString("en-US")} access errors · {skipped.toLocaleString("en-US")} excluded or duplicate entries</p>
    <p role="status" className="text-xs text-zinc-300 py-2">{data
      ? `${formatBytes(data.attributed_size)} in package folders · ${formatBytes(data.unattributed_size)} unattributed · ${data.total_packages.toLocaleString("en-US")} package IDs`
      : error ? "Package-folder usage unavailable" : "Loading package folders…"}</p>
    {error && <div role="alert" className="text-xs text-red-400 py-2">{error} <button disabled={busy} onClick={() => setRetry(value => value + 1)} className="underline">Retry</button></div>}
    {data?.total_packages === 0 && <p className="text-sm text-zinc-400 py-4">No package folders were recognized in this scanned scope.</p>}
    <table aria-busy={!data && !error} className="w-full text-xs text-left">
      <caption className="sr-only">Scanned package-folder bytes, sorted by package ID</caption>
      <thead className="text-zinc-500"><tr><th scope="col" className="py-2">Package ID</th><th scope="col" className="text-right px-2">Scanned bytes</th><th scope="col" className="text-right">Folders observed</th></tr></thead>
      <tbody className="divide-y divide-zinc-800/80">{data?.packages.map(row => <tr key={row.package_id} className="app-usage-row">
        <th scope="row" className="py-3 font-mono font-normal break-all">{row.package_id}</th>
        <td className="text-right px-2 font-mono text-zinc-400">{formatBytes(row.scanned_size)}</td>
        <td className="text-right font-mono text-zinc-400">{row.locations}</td>
      </tr>)}</tbody>
    </table>
    {data && <div className="flex gap-2 items-center py-3 text-xs">
      <button disabled={busy || skip === 0} onClick={() => setSkip(Math.max(0, skip - 100))} className="rounded bg-zinc-800 px-3 py-2 disabled:opacity-40">Previous</button>
      <span className="text-zinc-500">{data.packages.length} entries on this page</span>
      <button disabled={busy || data.next_skip === null} onClick={() => { if (data.next_skip !== null) setSkip(data.next_skip); }} className="rounded bg-zinc-800 px-3 py-2 disabled:opacity-40">Next</button>
    </div>}
  </section>;
}
