/** IPC records contain IDs and labels; only Rust owns the scan tree and paths. */
export interface ScanNode {
  id: number;
  parent_id: number | null;
  name: string;
  type: "file" | "directory";
  size: number;
  counted: boolean;
  child_count: number;
  can_delete: boolean;
}
export interface ScanResponse {
  status: string;
  generation: string;
  revision: number;
  root_path: string;
  root: ScanNode;
  streamed?: boolean;
  scan_time_ms: number;
  total_files: number;
  total_dirs: number;
  total_size: number;
  errors: number;
  read_only: boolean;
  skipped: number;
  /** Per-phase timings from daemon v1.2+ (issue #3); absent in older daemons. */
  traverse_ms?: number;
  sort_ms?: number;
  serialize_ms?: number;
  send_ms?: number;
  bytes_sent?: number;
}
export interface PageCursor { direction: "next" | "previous"; node_id: number }
export interface ScanView {
  generation: string;
  revision: number;
  node: ScanNode;
  path: string;
  breadcrumbs: { id: number; name: string }[];
  children: ScanNode[];
  previous_cursor: PageCursor | null;
  next_cursor: PageCursor | null;
  chart: { node_id: number | null; name: string; size: number }[];
}
export interface NodeDetail {
  generation: string;
  revision: number;
  node: ScanNode;
  path: string;
}
export interface DeleteResult {
  summary: ScanResponse;
  message: string;
  removed: { files: number; dirs: number; size: number };
}
export interface ScanScope { generation: string; revision: number }
/** Shared guards for scan IPC values before feature-specific validation. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isU32 = (value: unknown): value is number => isCount(value) && value <= 0xffff_ffff;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
const textBytes = (value: string) => {
  const bytes = encoder.encode(value);
  return decoder.decode(bytes) === value ? bytes.length : Infinity;
};
const entryName = (value: unknown): value is string => typeof value === "string" && value !== "" && value !== "." && value !== ".."
  && !value.includes("/") && !value.includes("\0") && textBytes(value) <= 255;
type NodeContext = Pick<ScanResponse, "root_path" | "read_only" | "total_size">;
const invalidNode = () => new Error("Scan node response does not match this scan");

/** Shared node/path contract; contextual actions still require their own scope. */
export function parseNodeReference(value: unknown, expected: NodeContext): Pick<NodeDetail, "node" | "path"> {
  if (!isRecord(value) || !isRecord(value.node) || typeof value.path !== "string") throw invalidNode();
  const node = value.node;
  if (!isU32(node.id) || typeof node.name !== "string"
    || (node.parent_id !== null && !isU32(node.parent_id)) || !isCount(node.size) || node.size > expected.total_size
    || !isCount(node.child_count) || typeof node.counted !== "boolean" || typeof node.can_delete !== "boolean"
    || (node.type !== "file" && node.type !== "directory")
    || (node.type === "file" && node.child_count !== 0)
    || (!node.counted && (node.size !== 0 || node.child_count !== 0))) throw invalidNode();
  const pathBytes = textBytes(value.path);
  if (pathBytes > 16 * 1024 || (node.can_delete && (expected.read_only || node.id === 0
    || /[\r\n\0]/.test(value.path) || pathBytes + "DELETE ".length > 16 * 1024))) throw invalidNode();
  if (node.id === 0) {
    const rootName = expected.root_path === "/" ? "/" : expected.root_path.slice(expected.root_path.lastIndexOf("/") + 1);
    if (node.parent_id !== null || node.type !== "directory" || !node.counted
      || node.name !== rootName || value.path !== expected.root_path) throw invalidNode();
  } else {
    if (!isU32(node.parent_id) || node.parent_id >= node.id || !entryName(node.name)) throw invalidNode();
    const prefix = expected.root_path === "/" ? "/" : `${expected.root_path}/`;
    const relative = value.path.startsWith(prefix) ? value.path.slice(prefix.length) : "";
    const parts = relative.split("/");
    if (!parts.every(entryName) || parts[parts.length - 1] !== node.name
      || (node.parent_id === 0) !== (parts.length === 1)) throw invalidNode();
  }
  return { path: value.path, node: {
    id: node.id, parent_id: node.parent_id, name: node.name,
    type: node.type, size: node.size, counted: node.counted, child_count: node.child_count, can_delete: node.can_delete,
  } };
}

/** Validate the fresh detail used by confirmation without accepting UI paths. */
export function parseNodeDetail(raw: string, expected: ScanScope & NodeContext, nodeId: number): NodeDetail {
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data) || typeof data.generation !== "string" || !isU32(data.revision) || !isU32(nodeId)
    || !sameScan({ generation: data.generation, revision: data.revision }, expected)) throw invalidNode();
  const reference = parseNodeReference(data, expected);
  if (reference.node.id !== nodeId) throw invalidNode();
  return { generation: data.generation, revision: data.revision, ...reference };
}
export function sameScan(a: ScanScope | null, b: ScanScope): boolean {
  return a?.generation === b.generation && a.revision === b.revision;
}
export function viewKey(scope: ScanScope, nodeId: number, cursor: PageCursor | null): string {
  return JSON.stringify([scope.generation, scope.revision, nodeId, cursor?.direction, cursor?.node_id]);
}
export interface ViewState {
  request: number;
  key: string;
  page?: ScanView;
  error?: string;
}
export type ViewAction =
  | { type: "start"; request: number; key: string }
  | { type: "success"; request: number; page: ScanView }
  | { type: "error"; request: number; error: string };
/** Responses to an older page/snapshot cannot replace the current request. */
export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  if (action.type === "start") return { request: action.request, key: action.key };
  if (action.request !== state.request) return state;
  if (action.type === "success") return { ...state, page: action.page };
  return { ...state, error: action.error };
}
