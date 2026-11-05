import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
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
  const pendingFocus = useRef<{
    key: string; request: number; container: Element; action: string;
    trigger: HTMLButtonElement; release: () => void;
  } | null>(null);
  const cancelFocus = useCallback(() => {
    const pending = pendingFocus.current;
    pendingFocus.current = null;
    pending?.release();
  }, []);
  useEffect(() => cancelFocus, [cancelFocus]);
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
  const rememberFocus = useCallback((key: string, trigger?: HTMLButtonElement) => {
    cancelFocus();
    const container = trigger?.closest("section") ?? trigger?.closest('[role="tree"]')?.parentElement;
    if (!trigger || !container || document.activeElement !== trigger) return;
    const leave = (event: FocusEvent) => {
      if (event.target !== trigger && event.target !== document.body) cancelFocus();
    };
    document.addEventListener("focusin", leave);
    pendingFocus.current = {
      key, request: request.current + 1, container, trigger, action: trigger.dataset.pageAction ?? "retry",
      release: () => document.removeEventListener("focusin", leave),
    };
  }, [cancelFocus]);
  // The query owner survives while its rendered page disappears. Wait for that
  // exact request and for its controls to mount (directory registration can
  // require another commit). Never restore into a superseded view or over a
  // control the user focused while waiting.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (!enabled || pending.key !== key || !pending.container.isConnected) {
      cancelFocus();
      return;
    }
    if (state.request !== pending.request || state.key !== key || (!state.page && !state.error)) return;
    if (document.activeElement !== document.body && document.activeElement !== pending.trigger) {
      cancelFocus();
      return;
    }
    const region = pending.container.querySelector(
      `[data-directory-query="${nodeId}"][data-directory-request="${pending.request}"]`,
    );
    const action = state.error ? "retry" : pending.action;
    const target = region?.querySelector<HTMLButtonElement>(`button[data-page-action="${action}"]:enabled`)
      ?? region?.querySelector<HTMLButtonElement>("button:enabled");
    if (target) {
      cancelFocus();
      target.focus();
    }
  });
  const go = useCallback((cursor: PageCursor | null, trigger?: HTMLButtonElement) => {
    rememberFocus(viewKey({ generation, revision }, nodeId, cursor), trigger);
    setPosition({ base, cursor });
  }, [base, generation, revision, nodeId, rememberFocus]);
  const retryQuery = useCallback((trigger?: HTMLButtonElement) => {
    rememberFocus(key, trigger);
    setRetry(value => value + 1);
  }, [key, rememberFocus]);
  return {
    request: state.request,
    page: enabled && state.key === key ? state.page : undefined,
    error: enabled && state.key === key ? state.error : undefined,
    go,
    retry: retryQuery,
  };
}
