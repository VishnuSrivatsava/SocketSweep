import { useEffect, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { sameScan, viewKey, viewReducer } from "./scanView";
import type { PageCursor, ScanScope, ScanView } from "./scanView";

export function useScanView(scope: ScanScope, nodeId: number, enabled: boolean) {
  const { generation, revision } = scope;
  const base = viewKey(scope, nodeId, null);
  const [position, setPosition] = useState<{ base: string; cursor: PageCursor | null }>({ base, cursor: null });
  // Reset synchronously on deletion/rescan/zoom, before the query effect runs.
  const cursor = position.base === base ? position.cursor : null;
  const key = viewKey(scope, nodeId, cursor);
  const [state, dispatch] = useReducer(viewReducer, { request: 0, key: "" });
  const request = useRef(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = ++request.current;
    let current = true;
    dispatch({ type: "start", request: id, key });
    void invoke<string>("get_scan_view", {
      generation, revision, nodeId, cursor,
    }).then(raw => {
      const page: ScanView = JSON.parse(raw);
      if (!sameScan(page, { generation, revision }) || page.node.id !== nodeId) throw new Error("Scan query returned an unexpected view");
      if (current) dispatch({ type: "success", request: id, page });
    }).catch(error => {
      if (current) dispatch({ type: "error", request: id, error: String(error) });
    });
    return () => { current = false; };
    // key includes scope, node and cursor; scope primitives avoid depending on
    // the caller's object identity while every queried value remains explicit.
  }, [key, enabled, retry, generation, revision, nodeId, cursor]);
  return {
    page: enabled && state.key === key ? state.page : undefined,
    error: enabled && state.key === key ? state.error : undefined,
    go: (cursor: PageCursor | null) => setPosition({ base, cursor }),
    retry: () => setRetry(value => value + 1),
  };
}
