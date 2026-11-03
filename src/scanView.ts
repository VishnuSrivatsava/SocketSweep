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
export interface ScanProgress {
  scan_id: string;
  files: number;
  directories: number;
  total_size: number;
  recent_names: string[];
}

export function parseScanProgress(value: unknown, scanId: string): ScanProgress | null {
  if (!isRecord(value) || value.scan_id !== scanId || !isCount(value.files)
    || !isCount(value.directories) || !isCount(value.total_size)
    || !Array.isArray(value.recent_names) || value.recent_names.length > 5
    || !value.recent_names.every(entryName)) return null;
  return { scan_id: scanId, files: value.files, directories: value.directories,
    total_size: value.total_size, recent_names: value.recent_names };
}

type NodeContext = Pick<ScanResponse, "root_path" | "read_only" | "total_size">;
const invalidNode = () => new Error("Scan node response does not match this scan");

function isScanNode(node: unknown): node is ScanNode {
  return isRecord(node) && isU32(node.id) && typeof node.name === "string"
    && (node.parent_id === null || isU32(node.parent_id)) && isCount(node.size)
    && isCount(node.child_count) && typeof node.counted === "boolean" && typeof node.can_delete === "boolean"
    && (node.type === "directory" || (node.type === "file" && node.child_count === 0))
    && (node.counted || (node.size === 0 && node.child_count === 0));
}

export function parseScanView(raw: string, scope: ScanScope, nodeId: number): ScanView {
  const data: unknown = JSON.parse(raw);
  const validCursor = (cursor: unknown, direction: PageCursor["direction"], anchor: number | undefined) =>
    cursor === null || (anchor !== undefined && isRecord(cursor)
      && cursor.direction === direction && cursor.node_id === anchor);
  if (!isRecord(data) || data.generation !== scope.generation || data.revision !== scope.revision
    || !isScanNode(data.node) || data.node.id !== nodeId || typeof data.path !== "string"
    || !Array.isArray(data.children) || data.children.length > 128
    || !data.children.every(child => isScanNode(child) && child.parent_id === nodeId)
    || new Set(data.children.map(child => child.id)).size !== data.children.length
    || !validCursor(data.previous_cursor, "previous", data.children[0]?.id)
    || !validCursor(data.next_cursor, "next", data.children[data.children.length - 1]?.id)
    || !Array.isArray(data.breadcrumbs)
    || !data.breadcrumbs.every(crumb => isRecord(crumb) && isU32(crumb.id) && typeof crumb.name === "string")
    || !Array.isArray(data.chart) || data.chart.length > 65
    || !data.chart.every(tile => isRecord(tile) && (tile.node_id === null || isU32(tile.node_id))
      && typeof tile.name === "string" && isCount(tile.size))) {
    throw new Error("Scan query returned an unexpected view");
  }
  return data as unknown as ScanView;
}

/** Shared node/path contract; contextual actions still require their own scope. */
export function parseNodeReference(value: unknown, expected: NodeContext): Pick<NodeDetail, "node" | "path"> {
  if (!isRecord(value) || !isRecord(value.node) || typeof value.path !== "string") throw invalidNode();
  const node = value.node;
  if (!isScanNode(node) || node.size > expected.total_size) throw invalidNode();
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

export function parseScanSummary(data: unknown): ScanResponse {
  const invalid = () => new Error("Invalid scan summary");
  if (!isRecord(data) || data.status !== "ok" || typeof data.generation !== "string" || !data.generation
    || !isU32(data.revision) || typeof data.root_path !== "string" || !data.root_path.startsWith("/")
    || data.root_path.includes("\0") || typeof data.read_only !== "boolean" || !isCount(data.total_size)
    || !isCount(data.total_files) || !isCount(data.total_dirs) || !isCount(data.errors)
    || !isCount(data.skipped) || !isCount(data.scan_time_ms)
    || (data.streamed !== undefined && typeof data.streamed !== "boolean")) throw invalid();
  for (const field of ["traverse_ms", "sort_ms", "serialize_ms", "send_ms", "bytes_sent"]) {
    if (data[field] !== undefined && !isCount(data[field])) throw invalid();
  }
  const { node } = parseNodeReference({ node: data.root, path: data.root_path }, {
    root_path: data.root_path, read_only: data.read_only, total_size: data.total_size,
  });
  if (node.id !== 0 || node.size !== data.total_size) throw invalid();
  return { ...data, root: node } as ScanResponse;
}

export function parseDeleteResult(data: unknown): DeleteResult {
  if (!isRecord(data) || typeof data.message !== "string" || !isRecord(data.removed)
    || !isCount(data.removed.files) || !isCount(data.removed.dirs) || !isCount(data.removed.size)) {
    throw new Error("Invalid deletion result");
  }
  return {
    summary: parseScanSummary(data.summary), message: data.message,
    removed: { files: data.removed.files, dirs: data.removed.dirs, size: data.removed.size },
  };
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
