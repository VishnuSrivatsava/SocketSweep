// Real log model/component. Synthetic replay only; no native app or IPC.
import { createRoot } from "react-dom/client";
import { TerminalLog } from "../src/TerminalLog";
import { appendLog, emptyLogHistory, MAX_LOG_ENTRIES, MAX_LOG_TEXT_UNITS } from "../src/logHistory";
import "../src/App.css";

const root = createRoot(document.getElementById("root"));
const rows = () => document.querySelectorAll("#terminal-log .log-entry");
const check = (condition, message) => { if (!condition) throw Error(message); };
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
const waitFor = async (predicate, message) => {
  const deadline = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > deadline) throw Error(message); await pause(); }
};
const layout = () => document.querySelector("#terminal-log > div").scrollHeight;
const renderMeasured = async history => {
  const start = performance.now();
  root.render(<TerminalLog history={history} />);
  await waitFor(() => rows().length === history.entries.length, "Log rows missing");
  document.querySelector("#terminal-log").open = true;
  layout();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return performance.now() - start;
};
const metrics = {};
const violations = [];
document.addEventListener("securitypolicyviolation", event => violations.push(event.blockedURI));
const report = async (passed, error) => {
  root.unmount();
  await fetch("/report", { method: "POST", body: JSON.stringify({ fixture: "log-history", passed, error, metrics,
    checks: passed ? ["bounded replay rows", "latest chronological entries", "visible discard notice", "long-message text budget", "truncation marker", "escaped diagnostic text", "fresh shutdown/error retained"] : undefined }) });
};

void (async () => {
  const messages = Array.from({ length: 20000 }, (_, i) => `[12:34:56] [SCAN ${i}] /sdcard/文件😀/` + "synthetic-path-".repeat(8));
  // Replay the former unbounded history through the same log component. This
  // measures row-count effects, not a complete old-app/new-app comparison.
  const legacy = { entries: messages, textUnits: messages.reduce((sum, entry) => sum + entry.length, 0), discarded: 0 };
  metrics.unbounded_render_layout_ms = await renderMeasured(legacy);
  metrics.unbounded_rows = rows().length;
  root.render(null);
  await waitFor(() => rows().length === 0, "Baseline did not unmount");

  let history = messages.reduce(appendLog, emptyLogHistory());
  metrics.bounded_render_layout_ms = await renderMeasured(history);
  metrics.bounded_rows = rows().length;
  check(rows().length === MAX_LOG_ENTRIES, "Replay exceeded row limit");
  check(rows()[0].textContent.includes("[SCAN 19500]"), "Wrong first retained entry");
  check(rows()[499].textContent.includes("[SCAN 19999]"), "Newest entry missing");
  const notice = document.getElementById("log-retention-notice");
  check(notice?.textContent.includes("19,500 older entries discarded"), "Discard notice missing");
  const bounds = notice.getBoundingClientRect();
  check(bounds.top >= 0 && bounds.bottom <= innerHeight, "Discard notice is outside the viewport");
  const list = document.querySelector("#terminal-log > div");
  list.scrollTop = list.scrollHeight;
  check(notice.getBoundingClientRect().top === bounds.top, "Discard notice scrolled out of view");

  history = emptyLogHistory();
  for (let i = 0; i < 1000; i++) history = appendLog(history, `[${i}] /sdcard/` + "📁".repeat(10000));
  await renderMeasured(history);
  check(history.textUnits <= MAX_LOG_TEXT_UNITS && rows().length < MAX_LOG_ENTRIES, "Long messages escaped text bound");
  check([...rows()].every(row => row.textContent.includes("… [truncated]")), "Truncation was not marked");
  history = appendLog(history, '[12:35:00] [ERROR] <img src="invalid" onerror="alert(1)">');
  history = appendLog(history, "[12:35:01] [SOCKET] App disconnected; daemon shutdown could not be confirmed: No Android device detected");
  root.render(<TerminalLog history={history} />);
  await waitFor(() => rows()[rows().length - 1]?.textContent.includes("shutdown could not be confirmed"), "Fresh shutdown/error missing");
  check(!document.querySelector("#terminal-log img") && document.querySelector("#terminal-log").textContent.includes("<img"), "Diagnostic text became markup");
  check(violations.length === 0, `CSP blocked resources: ${violations.join(", ")}`);
  metrics.long_message_rows = rows().length;
  metrics.long_message_text_bytes = history.textUnits * 2;
  metrics.viewport = { width: innerWidth, height: innerHeight, scale: devicePixelRatio };
  await report(true);
})().catch(error => report(false, error.stack ?? String(error)));
