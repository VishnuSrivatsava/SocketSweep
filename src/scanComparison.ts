import { sameScan, isRecord as object, isCount as count } from "./scanView";
import type { ScanScope } from "./scanView";

export interface PreviousScan {
  recorded_at: number;
  total_files: number;
  total_dirs: number;
  total_size: number;
}
export interface ScanComparison extends ScanScope {
  first: boolean;
  previous?: PreviousScan;
  delta?: { files: number; dirs: number; size: number };
}
type Expected = ScanScope & { total_files: number; total_dirs: number; total_size: number };
const change = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** Reject stale, malformed or non-reconciling comparisons before display. */
export function parseScanComparison(raw: string, expected: Expected): ScanComparison {
  const data: unknown = JSON.parse(raw);
  const invalid = () => new Error("Scan comparison does not match this scan");
  if (!object(data) || typeof data.generation !== "string" || !count(data.revision)
    || !sameScan({ generation: data.generation, revision: data.revision }, expected)
    || typeof data.first !== "boolean") throw invalid();
  if (data.first) {
    if (data.previous !== null || data.delta !== null) throw invalid();
    return { generation: data.generation, revision: data.revision, first: true };
  }
  if (!object(data.previous) || !count(data.previous.recorded_at) || (data.previous.recorded_at === 0 || data.previous.recorded_at > 8_640_000_000_000)
    || !count(data.previous.total_files) || !count(data.previous.total_dirs) || !count(data.previous.total_size)
    || !object(data.delta) || !change(data.delta.files) || !change(data.delta.dirs) || !change(data.delta.size)) throw invalid();
  // Previous totals plus the deltas must rebuild the totals the UI shows now.
  if (data.previous.total_files + data.delta.files !== expected.total_files
    || data.previous.total_dirs + data.delta.dirs !== expected.total_dirs
    || data.previous.total_size + data.delta.size !== expected.total_size) throw invalid();
  return {
    generation: data.generation,
    revision: data.revision,
    first: false,
    previous: {
      recorded_at: data.previous.recorded_at,
      total_files: data.previous.total_files,
      total_dirs: data.previous.total_dirs,
      total_size: data.previous.total_size,
    },
    delta: { files: data.delta.files, dirs: data.delta.dirs, size: data.delta.size },
  };
}
