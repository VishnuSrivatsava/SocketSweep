import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseScanComparison } from "./scanComparison";
import type { ScanComparison } from "./scanComparison";
import type { ScanResponse } from "./scanView";
import { formatBytes } from "./formatBytes";

const formatCount = (value: number): string =>
  `${value > 0 ? "+" : value < 0 ? "-" : ""}${Math.abs(value).toLocaleString("en-US")}`;

const formatChange = (value: number, unit: (bytes: number) => string): string =>
  value === 0 ? "0" : `${value > 0 ? "+" : "-"}${unit(Math.abs(value))}`;

/**
 * One line comparing the live snapshot with the previous successful scan of
 * the same device, folder and access mode. History is recorded only for
 * verified completions; queries never rescan the device.
 */
export function ScanHistory({ scope }: { scope: ScanResponse }) {
  const { generation, revision, total_files, total_dirs, total_size } = scope;
  const key = JSON.stringify([generation, revision, total_files, total_dirs, total_size]);
  const [state, setState] = useState<{ key: string; data?: ScanComparison; error?: string }>({ key: "" });
  useEffect(() => {
    let current = true;
    void invoke<string>("get_scan_comparison", { generation, revision }).then(raw => {
      const data = parseScanComparison(raw, { generation, revision, total_files, total_dirs, total_size });
      if (current) setState({ key, data });
    }).catch(() => {
      // The comparison is context, not a scan result; a failed query must not
      // claim anything about previous scans.
      if (current) setState({ key, error: "unavailable" });
    });
    return () => { current = false; };
  }, [generation, revision, total_files, total_dirs, total_size, key]);
  const data = state.key === key ? state.data : undefined;
  const error = state.key === key ? state.error : undefined;
  if (!data && !error) return null;
  let text: string;
  if (error || !data) {
    text = "Previous-scan comparison unavailable.";
  } else if (data.first) {
    text = "No previous comparable scan for this device and folder.";
  } else if (data.delta && data.previous) {
    const date = new Date(data.previous.recorded_at * 1000).toLocaleDateString("en-US");
    const unchanged = data.delta.files === 0 && data.delta.dirs === 0 && data.delta.size === 0;
    text = unchanged
      ? `No change since the scan recorded on ${date}.`
      : `Since the previous scan (${date}): ${[
          formatChange(data.delta.size, formatBytes),
          `${formatCount(data.delta.files)} files`,
          `${formatCount(data.delta.dirs)} folders`,
        ].join(" · ")}`;
  } else {
    text = "Previous-scan comparison unavailable.";
  }
  return <p id="scan-history" role="status" className="px-6 pt-1 text-xs text-zinc-500">{text}</p>;
}
