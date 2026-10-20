import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { preserveDeviceSelection } from "./devices";
import type { AndroidDevice } from "./devices";

export function useDevices(enabled: boolean) {
  const [devices, setDevices] = useState<AndroidDevice[]>([]);
  const [serial, select] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<AndroidDevice[]>("list_devices");
      if (id !== request.current) return;
      setDevices(result);
      select(previous => preserveDeviceSelection(previous, result));
    } catch (error) {
      if (id !== request.current) return;
      setDevices([]);
      setError(String(error));
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
