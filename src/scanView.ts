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
