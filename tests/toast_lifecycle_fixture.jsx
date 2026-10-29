// Production React and toast component, with controlled browser timers. No IPC.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastContainer } from "../src/ToastContainer";
import "../src/App.css";

const nativeTimeout = window.setTimeout.bind(window);
const nativeClear = window.clearTimeout.bind(window);
const timers = new Map();
let now = 0;
let nextId = -1;
window.setTimeout = (callback, delay, ...args) => {
  if (delay !== 5000 && delay !== 300) return nativeTimeout(callback, delay, ...args);
  const id = nextId--;
  timers.set(id, { at: now + delay, callback: () => callback(...args) });
  return id;
};
window.clearTimeout = id => { if (!timers.delete(id)) nativeClear(id); };
const advance = milliseconds => {
  const end = now + milliseconds;
  for (;;) {
    const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    timers.delete(next[0]);
    now = next[1].at;
    next[1].callback();
  }
  now = end;
};
const check = (condition, message) => { if (!condition) throw Error(message); };
const pause = () => new Promise(resolve => nativeTimeout(resolve, 20));
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(message);
    await pause();
  }
};
const root = createRoot(document.getElementById("root"));
let toasts = [];
const exits = [];
const removals = [];
const dismiss = id => {
  exits.push(id);
  toasts = toasts.map(toast => toast.id === id && !toast.exiting ? { ...toast, exiting: true } : toast);
  render();
};
const remove = id => {
  removals.push(id);
  toasts = toasts.filter(toast => toast.id !== id);
  render();
};
const render = () => root.render(<StrictMode><ToastContainer toasts={toasts} onDismiss={dismiss} onRemove={remove} /></StrictMode>);
const item = message => [...document.querySelectorAll("#toast-container > div")].find(element => element.textContent.includes(message));
const add = (...ids) => {
  toasts = ids.map(id => ({ id, message: `Toast ${id}`, type: id % 2 ? "info" : "error" }));
  render();
};
const report = async (passed, error) => {
  root.unmount();
  window.setTimeout = nativeTimeout;
  window.clearTimeout = nativeClear;
  await fetch("/report", { method: "POST", body: JSON.stringify({ fixture: "toast-lifecycle", passed, error,
    checks: passed ? ["toast status semantics", "natural expiry", "stable lifetime across rerenders", "early dismissal", "repeated dismissal", "dismissal during exit", "independent toasts", "unmount before expiry", "unmount during exit", "repeated notifications release timers"] : undefined }) });
  if (passed) location.replace("/tests/log_history_fixture.html");
};

void (async () => {
  add(1);
  await waitFor(() => item("Toast 1") && timers.size === 1, "Initial toast timer missing");
  check(item("Toast 1").getAttribute("role") === "status", "Info toast lacks status semantics");
  advance(4000);
  toasts = toasts.map(toast => ({ ...toast, message: "Toast 1 updated", type: "success" }));
  render();
  await waitFor(() => item("Toast 1 updated"), "Rerender missing");
  check(item("Toast 1 updated").getAttribute("role") === "status", "Success toast lacks status semantics");
  check([...timers.values()][0].at === 5000, "Rerender restarted lifetime");
  advance(999);
  check(!item("Toast 1").classList.contains("animate-toast-out"), "Toast expired before five seconds");
  advance(1);
  await waitFor(() => item("Toast 1").classList.contains("animate-toast-out") && timers.size === 1, "Natural expiry did not enter exit phase");
  check(getComputedStyle(item("Toast 1")).animationName === "toast-out", "Exit animation missing");
  advance(100);
  item("Toast 1").click();
  item("Toast 1").click();
  await pause();
  check(timers.size === 1 && [...timers.values()][0].at === 5300, "Dismissal during exit restarted or duplicated removal");
  advance(199);
  check(item("Toast 1"), "Exit was removed before 300 ms");
  advance(1);
  await waitFor(() => !item("Toast 1") && timers.size === 0, "Natural removal retained toast/timer");
  check(removals.filter(id => id === 1).length === 1, "Duplicate removal");

  add(2, 3);
  await waitFor(() => item("Toast 2") && item("Toast 3") && timers.size === 2, "Independent timers missing");
  check(item("Toast 2").getAttribute("role") === "alert", "Error toast lacks alert semantics");
  check(item("Toast 2").querySelector("span").getAttribute("aria-hidden") === "true", "Decorative toast icon is announced");
  advance(100);
  item("Toast 2").click();
  await waitFor(() => item("Toast 2").classList.contains("animate-toast-out") && timers.size === 2, "Early dismissal failed");
  advance(100);
  item("Toast 2").click();
  await pause();
  advance(200);
  await waitFor(() => !item("Toast 2") && timers.size === 1, "Repeated dismissal delayed removal");
  check(item("Toast 3") && !item("Toast 3").classList.contains("animate-toast-out"), "Dismissal affected another toast");
  advance(4599);
  check(item("Toast 3"), "Other toast expired early");
  advance(1);
  await waitFor(() => item("Toast 3").classList.contains("animate-toast-out") && timers.size === 1, "Other toast lifetime changed");
  advance(300);
  await waitFor(() => !item("Toast 3") && timers.size === 0, "Other toast cleanup failed");

  for (const phase of ["active", "exiting"]) {
    add(4);
    await waitFor(() => item("Toast 4") && timers.size === 1, "Unmount fixture did not mount");
    if (phase === "exiting") {
      advance(5000);
      await waitFor(() => item("Toast 4").classList.contains("animate-toast-out") && timers.size === 1, "Unmount exit phase missing");
    }
    root.render(null);
    await waitFor(() => !item("Toast 4") && timers.size === 0, "Unmount retained timer");
    const callbacks = exits.length + removals.length;
    advance(6000);
    await pause();
    check(exits.length + removals.length === callbacks, "Callback fired after unmount");
  }

  for (let id = 10; id < 30; id++) {
    add(id);
    await waitFor(() => item(`Toast ${id}`) && timers.size === 1, "Repeated notification did not mount");
    advance(5000);
    await waitFor(() => item(`Toast ${id}`).classList.contains("animate-toast-out") && timers.size === 1, "Repeated notification did not exit");
    advance(300);
    await waitFor(() => !item(`Toast ${id}`) && timers.size === 0, "Repeated notification retained resources");
  }
  await report(true);
})().catch(error => report(false, error.stack ?? String(error)));
