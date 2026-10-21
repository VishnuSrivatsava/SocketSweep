// Development React exercises the real StrictMode effect replay. IPC is mocked.
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useDevices } from "../src/useDevices";

let model;
let effects = 0;
let calls = 0;
const pending = [];
const check = (condition, message) => { if (!condition) throw Error(message); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, message) => {
  const end = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > end) throw Error(message); await pause(10); }
};
window.__TAURI_INTERNALS__ = {
  invoke: command => {
    check(command === "list_devices", "Unexpected device operation");
    calls++;
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  },
};
function Probe() {
  model = useDevices(true);
  useEffect(() => { effects++; }, []);
  return <p>{model.loading ? "Checking" : "Finished"}</p>;
}
const root = createRoot(document.getElementById("root"));
const report = async (passed, error) => {
  await fetch("/report", { method: "POST", body: JSON.stringify({ fixture: "device-discovery", passed, error, effects, calls,
    checks: passed ? ["development StrictMode replay", "coalesced pending discovery", "refresh after success/error", "unmount invalidation"] : undefined }) });
  if (passed) location.replace("/");
};
void (async () => {
  root.render(<StrictMode><Probe /></StrictMode>);
  await waitFor(() => effects === 2, "Fixture did not exercise development StrictMode");
  check(calls === 1, `StrictMode launched ${calls} simultaneous discovery commands`);
  const a = model.refresh();
  const b = model.refresh();
  check(calls === 1, "Repeated refresh launched another pending command");
  pending.shift().resolve([{ serial: "chosen", state: "device", model: null }]);
  await Promise.all([a, b]);
  await waitFor(() => model.ready, "Latest subscriber did not receive discovery");

  const failed = model.refresh();
  check(calls === 2, "Settled discovery was reused as a cached result");
  pending.shift().reject("ADB server didn't ACK\n<bad diagnostic>");
  await failed;
  await waitFor(() => model.error && !model.loading, "Discovery failure did not finish");
  check(model.serial === "chosen" && !model.ready, "Failure replaced selection or granted readiness");

  const recovered = model.refresh();
  check(calls === 3, "Failed discovery prevented a fresh retry");
  pending.shift().resolve([{ serial: "chosen", state: "device", model: null }]);
  await recovered;
  await waitFor(() => model.ready && !model.error, "Discovery retry did not recover");

  const abandoned = model.refresh();
  check(calls === 4, "Final discovery missing");
  root.unmount();
  pending.shift().reject("late failure");
  await abandoned;
  check(!document.querySelector("#root").textContent, "Unmounted discovery changed the UI");
  await report(true);
})().catch(error => report(false, error.stack ?? String(error)));
