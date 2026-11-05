import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { getScanView } from "./scanIpc";
import { viewKey, viewReducer } from "./scanView";
import type { PageCursor, ScanScope } from "./scanView";

export function useScanView(scope: ScanScope, nodeId: number, enabled: boolean) {
  const { generation, revision } = scope;
  const base = viewKey(scope, nodeId, null);
  const [position, setPosition] = useState<{ base: string; cursor: PageCursor | null }>({ base, cursor: null });
  // Reset synchronously on deletion/rescan/zoom, before the query effect runs.
  const cursor = position.base === base ? position.cursor : null;
  const { direction: cursorDirection, node_id: cursorNodeId } = cursor ?? {};
  const key = viewKey(scope, nodeId, cursor);
  const [state, dispatch] = useReducer(viewReducer, { request: 0, key: "" });
  const request = useRef(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = ++request.current;
    let current = true;
    dispatch({ type: "start", request: id, key });
    const queryCursor = cursorDirection !== undefined && cursorNodeId !== undefined
      ? { direction: cursorDirection, node_id: cursorNodeId } : null;
    void getScanView({ generation, revision }, nodeId, queryCursor).then(page => {
      if (current) dispatch({ type: "success", request: id, page });
    }).catch(error => {
      if (current) dispatch({ type: "error", request: id, error: String(error) });
    });
    return () => { current = false; };
    // key includes scope, node and cursor; primitive dependencies keep requests
    // stable across equivalent scope/cursor objects while listing every input.
  }, [key, enabled, retry, generation, revision, nodeId, cursorDirection, cursorNodeId]);
  const go = useCallback((cursor: PageCursor | null) => setPosition({ base, cursor }), [base]);
  const retryQuery = useCallback(() => setRetry(value => value + 1), []);
  return {
    page: enabled && state.key === key ? state.page : undefined,
    error: enabled && state.key === key ? state.error : undefined,
    go,
    retry: retryQuery,
  };
}
