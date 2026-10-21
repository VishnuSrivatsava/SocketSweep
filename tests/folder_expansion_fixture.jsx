// Real tree/query components with controlled indicator timers and mocked IPC.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { FileTreeNode } from "../src/FileTree";
import "../src/App.css";

const nativeTimeout = window.setTimeout.bind(window);
const nativeClear = window.clearTimeout.bind(window);
const timers = new Map();
let nextTimer = -1;
let now = 0;
window.setTimeout = (callback, delay, ...args) => {
  if (delay !== 150) return nativeTimeout(callback, delay, ...args);
  const id = nextTimer--;
  timers.set(id, { at: now + delay, callback: () => callback(...args) });
  return id;
};
window.clearTimeout = id => { if (!timers.delete(id)) nativeClear(id); };
const advance = milliseconds => {
  now += milliseconds;
  for (const [id, timer] of [...timers]) if (timer.at <= now) {
    timers.delete(id);
    timer.callback();
  }
};
const pause = () => new Promise(resolve => nativeTimeout(resolve, 20));
const check = (condition, message) => { if (!condition) throw Error(message); };
const waitFor = async (predicate, message) => {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw Error(message); await pause(); }
};
const directory = (id, name, child_count) => ({ id, name, child_count, type: "directory", size: 3, counted: true, can_delete: false });
const parent = directory(1, "parent", 2);
const nested = directory(2, "nested", 1);
const file = name => ({ id: 3, parent_id: 1, name, child_count: 0, type: "file", size: 1, counted: true, can_delete: false });
let scope = { generation: "first", revision: 0 };
let expanded = new Set();
let deferred = false;
const pending = [];
window.__TAURI_INTERNALS__ = {
  invoke: (command, args) => {
    check(command === "get_scan_view", "Unexpected tree operation");
    const node = args.nodeId === 1 ? parent : nested;
    const leaf = file(`leaf-${args.generation}-${args.revision}`);
    const page = { generation: args.generation, revision: args.revision, node,
      children: args.nodeId === 1 ? [nested, leaf] : [{ ...leaf, id: 4, parent_id: 2, name: "deep-leaf" }],
      previous_cursor: null, next_cursor: null, chart: [], breadcrumbs: [], path: "/fixture" };
    const raw = JSON.stringify(page);
    return deferred ? new Promise((resolve, reject) => pending.push({ nodeId: args.nodeId, resolve: () => resolve(raw), reject })) : Promise.resolve(raw);
  },
};
const root = createRoot(document.getElementById("root"));
const toggle = id => {
  expanded = new Set(expanded);
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  render();
};
const render = () => root.render(<StrictMode><FileTreeNode node={parent} scope={scope} parentSize={3} depth={1}
  expanded={expanded} toggle={toggle} busy={false} onNuke={() => { throw Error("Unexpected delete"); }} onZoom={() => { throw Error("Unexpected zoom"); }} /></StrictMode>);
const folder = name => [...document.querySelectorAll(".file-row")].find(row => row.textContent.includes(name))?.querySelector("button[aria-expanded]");
const rows = () => document.querySelectorAll(".file-row");
const status = () => document.querySelector('[role="status"]');
const request = async id => {
  await waitFor(() => pending.some(item => item.nodeId === id), `Missing query for ${id}`);
  return pending.splice(pending.findIndex(item => item.nodeId === id), 1)[0];
};
let flashes = 0;
const observer = new MutationObserver(records => {
  for (const record of records) for (const node of record.addedNodes) {
    if (node.nodeType === Node.ELEMENT_NODE && (node.matches('[role="status"]') || node.querySelector('[role="status"]'))) flashes++;
  }
});
observer.observe(document.getElementById("root"), { subtree: true, childList: true });
let mounted = true;
const report = async (passed, error) => {
  if (mounted) root.unmount();
  observer.disconnect();
  window.setTimeout = nativeTimeout;
  window.clearTimeout = nativeClear;
  await fetch("/report", { method: "POST", body: JSON.stringify({ fixture: "folder-expansion", passed, error,
    checks: passed ? ["fast parent/nested expansions without flash", "150 ms slow-query feedback", "immediate result/error rendering", "collapse/reopen cleanup", "retry", "generation/revision timer reset", "late responses ignored", "unmount cleanup"] : undefined }) });
  if (passed) location.replace("/");
};

void (async () => {
  render();
  await waitFor(() => folder("parent"), "Parent missing");
  folder("parent").click();
  await waitFor(() => rows().length === 3, "Fast expansion did not render children");
  folder("nested").click();
  await waitFor(() => rows().length === 4, "Fast nested expansion missing");
  advance(150);
  await pause();
  check(flashes === 0 && !status() && timers.size === 0, "Fast expansion flashed loading text");
  folder("nested").click();
  folder("parent").click();
  await waitFor(() => rows().length === 1, "Collapse missing");

  deferred = true;
  folder("parent").click();
  let query = await request(1);
  check(!status(), "Loading text appeared immediately");
  check(folder("parent").getAttribute("aria-busy") === "true", "Pending folder lacks busy state");
  advance(149);
  await pause();
  check(!status(), "Loading text appeared before 150 ms");
  advance(1);
  await waitFor(() => status(), "Slow expansion lacks accessible status");
  query.resolve();
  await waitFor(() => rows().length === 3 && !status(), "Result waited for a minimum indicator duration");
  check(timers.size === 0 && folder("parent").getAttribute("aria-busy") === "false", "Completed folder retained pending state");

  folder("nested").click();
  query = await request(2);
  advance(150);
  await waitFor(() => status(), "Slow nested expansion lacks status");
  query.resolve();
  await waitFor(() => rows().length === 4 && !status(), "Nested result missing");
  folder("nested").click();
  folder("parent").click();
  await waitFor(() => rows().length === 1, "Collapse missing before race");

  folder("parent").click();
  const abandoned = await request(1);
  advance(100);
  folder("parent").click();
  await pause();
  advance(50);
  abandoned.resolve();
  await pause();
  check(rows().length === 1 && !status() && timers.size === 0, "Collapsed query retained rows/status/timer");
  folder("parent").click();
  query = await request(1);
  advance(149);
  await pause();
  check(!status(), "Reopening reused the previous timer");
  query.reject("Fixture query failure");
  await waitFor(() => document.body.textContent.includes("Fixture query failure"), "Error was delayed");
  check(!status() && timers.size === 0, "Failure retained the indicator timer");
  [...document.querySelectorAll("button")].find(button => button.textContent === "Retry").click();
  query = await request(1);
  advance(150);
  await waitFor(() => status(), "Retry lacks slow-query feedback");
  query.resolve();
  await waitFor(() => rows().length === 3 && !status(), "Retry did not recover");

  for (const nextScope of [{ generation: "next", revision: 0 }, { generation: "next", revision: 1 }]) {
    folder("parent").click();
    await waitFor(() => rows().length === 1, "Scope fixture did not collapse");
    folder("parent").click();
    const old = await request(1);
    advance(100);
    scope = nextScope;
    render();
    query = await request(1);
    advance(50);
    if (nextScope.revision === 0) old.resolve(); else old.reject("Stale scope failure");
    await pause();
    check(rows().length === 1 && !status() && !document.querySelector('[role="alert"]'), "Old response or indicator crossed scan scope");
    advance(100);
    await waitFor(() => status(), "New scope did not restart the indicator delay");
    query.resolve();
    await waitFor(() => rows().length === 3 && !status(), "New scope result missing");
    check(document.body.textContent.includes(`leaf-${scope.generation}-${scope.revision}`), "Wrong scan displayed");
  }

  folder("parent").click();
  await waitFor(() => rows().length === 1, "Unmount fixture did not collapse");
  folder("parent").click();
  query = await request(1);
  check(timers.size === 1, "Pending indicator timer missing");
  root.unmount();
  mounted = false;
  advance(150);
  query.reject("Late unmounted failure");
  await pause();
  check(timers.size === 0 && !document.getElementById("root").textContent, "Unmount retained query UI/timer");
  await report(true);
})().catch(error => report(false, error.stack ?? String(error)));
