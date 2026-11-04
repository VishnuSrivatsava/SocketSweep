import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { deviceDiscoveryMessage, parseDeviceList, preserveDeviceSelection } from "./devices";
import { boundDiagnostic } from "./logHistory";
import type { AndroidDevice } from "./devices";

export function useDevices(enabled: boolean, addLog: (message: string) => void) {
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [serial, select] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; details: string } | null>(null);
  const request = useRef(0);
  const pending = useRef<Promise<AndroidDevice[]> | null>(null);
  const completed = useRef<{ id: number; started: number; finished: number; label: string } | null>(null);
  const discover = useCallback(async (source: "setup" | "refresh") => {
    const id = ++request.current;
    const started = performance.now();
    let outcome = "failed";
    setLoading(true);
    setError(null);
    try {
      // StrictMode replays setup effects while their IPC is still pending.
      // Share only that in-flight command; settled lists are never cached.
      const result = await (pending.current ??= invoke<unknown>("list_devices")
        .then(parseDeviceList)
        .finally(() => { pending.current = null; }));
      if (id !== request.current) return;
      outcome = `${result.filter(device => device.state === "device").length} ready of ${result.length}`;
      setDevices(result);
      select(previous => preserveDeviceSelection(previous, result));
    } catch (error) {
      if (id !== request.current) return;
      setDevices([]);
      const details = String(error);
      setError({ message: deviceDiscoveryMessage(details), details: boundDiagnostic(details) });
    } finally {
      if (id === request.current) {
        completed.current = { id, started, finished: performance.now(), label: `${source}, ${outcome}` };
        setLoading(false);
      }
    }
  }, []);
  useEffect(() => {
    const timing = completed.current;
    if (!enabled || loading || !timing || timing.id !== request.current) return;
    completed.current = null;
    const requestMs = Math.round(timing.finished - timing.started);
    const pickerMs = Math.round(performance.now() - timing.finished);
    addLog(`[ADB] Discovery (${timing.label}): response ${requestMs} ms, picker effect ${pickerMs} ms.`);
  }, [enabled, loading, devices, addLog]);
  useEffect(() => {
    if (!enabled) return;
    void discover("setup");
    return () => { request.current += 1; };
  }, [enabled, discover]);
  const refresh = useCallback(() => discover("refresh"), [discover]);
  return {
    devices, serial, select, loading, error, refresh,
    ready: !loading && error === null && devices.some(device => device.serial === serial && device.state === "device"),
  };
}
