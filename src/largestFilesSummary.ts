import { sameScan, isRecord, isCount } from "./scanView";
import type { ScanScope, ScanResponse, NodeDetail } from "./scanView";

export interface LargestResponse extends ScanScope {
  limit: number;
  total_files: number;
  files: Pick<NodeDetail, "node" | "path">[];
}
type Expected = Pick<ScanResponse, "generation" | "revision" | "root_path" | "read_only" | "total_files" | "total_size">;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const id = (value: unknown): value is number => isCount(value) && value <= 0xffff_ffff;
const textBytes = (value: string) => {
  const bytes = encoder.encode(value);
  return decoder.decode(bytes) === value ? bytes.length : Infinity;
};
const name = (value: unknown): value is string => typeof value === "string" && value !== "" && value !== "." && value !== ".."
  && !value.includes("/") && !value.includes("\0") && textBytes(value) <= 255;

/** Validate bounded, scoped regular-file rows before rendering action controls. */
export function parseLargestFiles(raw: string, expected: Expected, limit: number): LargestResponse {
  const data: unknown = JSON.parse(raw);
  const invalid = () => new Error("Largest-files response does not match this scan");
  if (!isRecord(data) || typeof data.generation !== "string" || !id(data.revision)
    || !sameScan({ generation: data.generation, revision: data.revision }, expected)
    || !isCount(limit) || limit < 1 || limit > 100 || data.limit !== limit
    || !isCount(data.total_files) || data.total_files !== expected.total_files
    || !Array.isArray(data.files) || data.files.length !== Math.min(limit, data.total_files)) throw invalid();
  const files: LargestResponse["files"] = [];
  const seen = new Set<number>();
  const paths = new Set<string>();
  const prefix = expected.root_path === "/" ? "/" : `${expected.root_path}/`;
  let bytes = 0;
  for (const file of data.files) {
    if (!isRecord(file) || !isRecord(file.node) || typeof file.path !== "string" || paths.has(file.path)) throw invalid();
    const node = file.node;
    if (!id(node.id) || node.id === 0 || seen.has(node.id) || !id(node.parent_id) || node.parent_id >= node.id
      || !name(node.name) || node.type !== "file" || node.counted !== true || node.child_count !== 0
      || !isCount(node.size) || typeof node.can_delete !== "boolean") throw invalid();
    const pathBytes = textBytes(file.path);
    const relative = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : "";
    const parts = relative.split("/");
    if (pathBytes > 16 * 1024 || !parts.every(name) || parts[parts.length - 1] !== node.name
      || (node.parent_id === 0) !== (parts.length === 1)
      || (node.can_delete && (expected.read_only || /[\r\n\0]/.test(file.path) || pathBytes + "DELETE ".length > 16 * 1024))) throw invalid();
    bytes += node.size;
    if (!isCount(bytes) || bytes > expected.total_size || (files.length > 0 && node.size > files[files.length - 1].node.size)) throw invalid();
    seen.add(node.id);
    paths.add(file.path);
    files.push({ path: file.path, node: {
      id: node.id, parent_id: node.parent_id, name: node.name, type: "file", size: node.size,
      counted: true, child_count: 0, can_delete: node.can_delete,
    } });
  }
  if (files.length === data.total_files && bytes !== expected.total_size) throw invalid();
  return { generation: data.generation, revision: data.revision, limit, total_files: data.total_files, files };
}
