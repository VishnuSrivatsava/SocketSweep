import { sameScan, isRecord, isCount, isU32, parseNodeReference } from "./scanView";
import type { ScanScope, ScanResponse, NodeDetail } from "./scanView";

export interface LargestResponse extends ScanScope {
  limit: number;
  total_files: number;
  files: Pick<NodeDetail, "node" | "path">[];
}
type Expected = Pick<ScanResponse, "generation" | "revision" | "root_path" | "read_only" | "total_files" | "total_size">;
/** Validate bounded, scoped regular-file rows before rendering action controls. */
export function parseLargestFiles(raw: string, expected: Expected, limit: number): LargestResponse {
  const data: unknown = JSON.parse(raw);
  const invalid = () => new Error("Largest-files response does not match this scan");
  if (!isRecord(data) || typeof data.generation !== "string" || !isU32(data.revision)
    || !sameScan({ generation: data.generation, revision: data.revision }, expected)
    || !isCount(limit) || limit < 1 || limit > 100 || data.limit !== limit
    || !isCount(data.total_files) || data.total_files !== expected.total_files
    || !Array.isArray(data.files) || data.files.length !== Math.min(limit, data.total_files)) throw invalid();
  const files: LargestResponse["files"] = [];
  const seen = new Set<number>();
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of data.files) {
    const reference = parseNodeReference(file, expected);
    const { node, path } = reference;
    if (node.id === 0 || seen.has(node.id) || paths.has(path)
      || node.type !== "file" || !node.counted) throw invalid();
    bytes += node.size;
    if (!isCount(bytes) || bytes > expected.total_size || (files.length > 0 && node.size > files[files.length - 1].node.size)) throw invalid();
    seen.add(node.id);
    paths.add(path);
    files.push(reference);
  }
  if (files.length === data.total_files && bytes !== expected.total_size) throw invalid();
  return { generation: data.generation, revision: data.revision, limit, total_files: data.total_files, files };
}
