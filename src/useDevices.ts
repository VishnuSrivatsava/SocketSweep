import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { deviceDiscoveryMessage, preserveDeviceSelection } from "./devices";
import { boundDiagnostic } from "./logHistory";
import type { AndroidDevice } from "./devices";

export function useDevices(enabled: boolean) {
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [serial, select] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; details: string } | null>(null);
  const request = useRef(0);
  const pending = useRef<Promise<AndroidDevice[]> | null>(null);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      // StrictMode replays setup effects while their IPC is still pending.
      // Share only that in-flight command; settled lists are never cached.
      const result = await (pending.current ??= invoke<AndroidDevice[]>("list_devices")
        .finally(() => { pending.current = null; }));
      if (id !== request.current) return;
      setDevices(result);
      select(previous => preserveDeviceSelection(previous, result));
    } catch (error) {
      if (id !== request.current) return;
      setDevices([]);
      const details = String(error);
      setError({ message: deviceDiscoveryMessage(details), details: boundDiagnostic(details) });
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    return () => { request.current += 1; };
  }, [enabled, refresh]);
  return {
    devices, serial, select, loading, error, refresh,
    ready: !loading && error === null && devices.some(device => device.serial === serial && device.state === "device"),
  };
}
