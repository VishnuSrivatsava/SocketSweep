import { invoke } from "@tauri-apps/api/core";
import { isRecord } from "./scanView";

export const checkAdb = () => invoke<string>("check_adb");

export const startDaemon = (serial: string, rootMode: boolean) =>
  invoke<string>("init_daemon", { serial, rootMode });

export const stopDaemon = () => invoke<string>("stop_daemon");

export async function confirmDaemonShutdown() {
  const raw = await stopDaemon();
  let response: unknown;
  try {
    response = JSON.parse(raw);
  } catch {
    throw new Error("Daemon did not acknowledge shutdown");
  }
  if (!isRecord(response) || response.status !== "ok" || response.message !== "shutting down") {
    throw new Error("Daemon did not acknowledge shutdown");
  }
}
