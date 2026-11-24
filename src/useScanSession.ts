import { useState, useCallback, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { deleteScanNode, getScanNode, exportScanFile, cancelExport } from "./scanIpc";
import { checkAdb, confirmDaemonShutdown, startDaemon, stopDaemon } from "./daemonIpc";
import { formatBytes } from "./formatBytes";
import { sameScan } from "./scanView";
import type { ScanResponse, NodeDetail } from "./scanView";
import { parseExportProgress, classifyExportError } from "./exportTransfer";
import type { ExportStage } from "./exportTransfer";
import { useDevices } from "./useDevices";
import { useScanRequest } from "./useScanRequest";
import type { Toast } from "./ToastContainer";

type PushToast = (message: string, type?: Toast["type"]) => void;

/** One-line phase breakdown for the terminal log; null if the daemon predates #3. */
const scanPhaseLog = (r: ScanResponse): string | null => {
  if (r.traverse_ms === undefined) return null;
  const kb = r.bytes_sent !== undefined ? `, ${(r.bytes_sent / 1024).toFixed(0)} KB sent` : "";
  return `[SCAN] ${r.streamed ? "Stream timings (overlap): scan" : "Phases: traverse"} ${r.traverse_ms}ms · sort ${r.sort_ms}ms · serialize ${r.serialize_ms}ms · send ${r.send_ms}ms${kb}`;
};

type AppPhase = "setup" | "connecting" | "scanning" | "result";

export function useScanSession(pushToast: PushToast, addLog: (message: string) => void) {
  const [phase, setPhase] = useState<AppPhase>("setup");
  const deviceSelection = useDevices(phase === "setup", addLog);
  const { serial: selectedSerial, ready: deviceReady } = deviceSelection;
  const [rootMode, setRootMode] = useState(false);
  const [rootPath, setRootPath] = useState("/data");
  const [scanData, setScanData] = useState<ScanResponse | null>(null);
  const snapshot = useRef<ScanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const confirmationRequest = useRef(0);
  const [confirmDelete, setConfirmDelete] = useState<(NodeDetail & { trigger: HTMLButtonElement }) | null>(null);
  const [statusText, setStatusText] = useState("Initializing…");
  const { scanProgress, cancelling, runScan, cancelScan } = useScanRequest(pushToast);
  const requestScan = useCallback((path: string) => {
    snapshot.current = null;
    confirmationRequest.current += 1;
    setConfirmDelete(null);
    return runScan(path);
  }, [runScan]);

  // ── Connect flow ────────────────────────────────────────────────────────
  const handleConnect = useCallback(async () => {
    if (actionPending.current || !deviceReady || !selectedSerial) return;
    actionPending.current = true;
    setPhase("connecting");
    const scanPath = rootMode ? rootPath : "/sdcard";
    let initialized = false;
    try {
      setStatusText("Checking ADB…");
      addLog("[ADB] Checking version...");
      const adbVersion = await checkAdb();
      addLog(`[ADB] Found: ${adbVersion}`);

      setStatusText(rootMode ? "Requesting root access…" : "Pushing daemon to device…");
      addLog(`[ADB] Starting an owned daemon session on ${selectedSerial}...`);
      await startDaemon(selectedSerial, rootMode);
      initialized = true;
      addLog("[SOCKET] Daemon started and connected via TCP tunnel!");

      setPhase("scanning");
      setStatusText(`Scanning ${scanPath} …`);
      addLog(`[SCAN] Requesting ${scanPath}${rootMode ? " with read-only root access" : ""}...`);
      const parsed = await requestScan(scanPath);

      snapshot.current = parsed;
      setScanData(parsed);
      setPhase("result");
      addLog(`[SCAN] Complete! ${parsed.total_files} files, ${parsed.scan_time_ms}ms.`);
      const phases = scanPhaseLog(parsed);
      if (phases) addLog(phases);
    } catch (err: unknown) {
      if (initialized) {
        try { await stopDaemon(); } catch { /* show the original connection error */ }
      }
      const message = err instanceof Error ? err.message : String(err);
      pushToast(message.split("\n", 1)[0], message === "Scan cancelled" ? "info" : "error");
      addLog(`${message === "Scan cancelled" ? "[SCAN]" : "[ERROR]"} ${message}`);
      setPhase("setup");
    } finally {
      actionPending.current = false;
    }
  }, [pushToast, addLog, rootMode, rootPath, requestScan, selectedSerial, deviceReady]);

  // ── Rescan ──────────────────────────────────────────────────────────────
  const handleRescan = useCallback(async () => {
    if (!scanData || actionPending.current) return;
    actionPending.current = true;
    const scanPath = scanData.root_path;
    setPhase("scanning");
    setStatusText(`Re-scanning ${scanPath} …`);
    addLog(`[SCAN] Re-scanning ${scanPath}...`);
    try {
      const parsed = await requestScan(scanPath);
      snapshot.current = parsed;
      setScanData(parsed);
      setPhase("result");
      addLog(`[SCAN] Complete! ${parsed.scan_time_ms}ms.`);
      const phases = scanPhaseLog(parsed);
      if (phases) addLog(phases);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast(message, message === "Scan cancelled" ? "info" : "error");
      addLog(`${message === "Scan cancelled" ? "[SCAN]" : "[ERROR]"} ${message}`);
      // The failed generation is not an authoritative deletion root. Clear
      // old results rather than offering actions backed by an invalid scan.
      try { await stopDaemon(); } catch { /* retain the scan error */ }
      setScanData(null);
      setPhase("setup");
    } finally {
      actionPending.current = false;
    }
  }, [pushToast, addLog, scanData, requestScan]);

  // ── Disconnect ──────────────────────────────────────────────────────────
  const handleDisconnect = useCallback(async () => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    snapshot.current = null;
    confirmationRequest.current += 1;
    setConfirmDelete(null);
    addLog("[SOCKET] Disconnecting daemon...");
    try {
      await confirmDaemonShutdown();
      pushToast("Daemon shutdown acknowledged", "info");
      addLog("[SOCKET] Daemon acknowledged shutdown. App disconnected.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pushToast("App disconnected; daemon shutdown could not be confirmed", "info");
      addLog(`[SOCKET] App disconnected; daemon shutdown could not be confirmed: ${message}`);
    } finally {
      setScanData(null);
      setPhase("setup");
      actionPending.current = false;
      setBusy(false);
    }
  }, [pushToast, addLog]);

  // Resolve confirmation details separately; destructive IPC accepts only IDs.
  const handleNuke = useCallback(async (nodeId: number, trigger: HTMLButtonElement) => {
    const scope = snapshot.current;
    if (!scope || scope.read_only || actionPending.current) return;
    const request = ++confirmationRequest.current;
    try {
      const detail = await getScanNode(scope, nodeId);
      if (request === confirmationRequest.current && !actionPending.current && sameScan(snapshot.current, scope) && detail.node.can_delete) {
        setConfirmDelete({ ...detail, trigger });
      }
    } catch (err) {
      if (request === confirmationRequest.current && sameScan(snapshot.current, scope)) pushToast(String(err), "error");
    }
  }, [pushToast]);

  const executeDelete = useCallback(async () => {
    const target = confirmDelete;
    confirmationRequest.current += 1;
    setConfirmDelete(null);
    if (!target || actionPending.current || !sameScan(snapshot.current, target)) return;
    actionPending.current = true;
    setBusy(true);
    addLog(`[DELETE] Requesting deletion of ${target.path}...`);
    try {
      const result = await deleteScanNode(target, target.node.id);
      if (!sameScan(snapshot.current, target)) return;
      snapshot.current = result.summary;
      setScanData(result.summary);
      pushToast(`Successfully deleted ${target.node.name}`, "success");
      addLog(`[DELETE] Success: ${result.message}`);
      addLog(`[DELETE] Scan updated (removed ${result.removed.files} files, ${result.removed.dirs} dirs, ${formatBytes(result.removed.size)})`);
    } catch (err: unknown) {
      if (!sameScan(snapshot.current, target)) return;
      const message = err instanceof Error ? err.message : String(err);
      snapshot.current = null;
      setScanData(null);
      setPhase("connecting");
      pushToast(`Delete failed: ${message}. Reconnect and rescan before continuing.`, "error");
      addLog(`[ERROR] Delete failed: ${message}`);
      // The daemon may have partially deleted a directory before reporting an
      // error. Discard its snapshot; never offer a blind retry with stale IDs.
      try { await stopDaemon(); } catch { /* retain the deletion error */ }
      setPhase("setup");
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }, [confirmDelete, pushToast, addLog]);

  const cancelDelete = () => {
    confirmationRequest.current += 1;
    setConfirmDelete(null);
  };

  // ── Export ──────────────────────────────────────────────────────────────
  // The backend owns the save picker, staging and commit; the frontend only
  // forwards IDs, renders progress, and never sees a device or destination
  // path it could forge. Export failures never invalidate the scan snapshot:
  // the transfer is read-only, unlike deletion.
  const [exportState, setExportState] = useState<{
    exportId: string; name: string; size: number; stage: ExportStage; bytesCopied: number; totalBytes: number;
  } | null>(null);
  const [exportCancelling, setExportCancelling] = useState(false);
  const exportActive = useRef<string | null>(null);

  const handleExport = useCallback(async (nodeId: number, name: string, size: number) => {
    const scope = snapshot.current;
    if (!scope || actionPending.current) return;
    // Export eligibility follows the shell-readable shared-storage policy, so
    // read-only root sessions cannot export regardless of what they scanned.
    if (scope.read_only) {
      pushToast("Export is available in normal-mode scans only.", "info");
      return;
    }
    actionPending.current = true;
    setBusy(true);
    const exportId = crypto.randomUUID();
    exportActive.current = exportId;
    setExportCancelling(false);
    setExportState({ exportId, name, size, stage: "transferring", bytesCopied: 0, totalBytes: size });
    addLog(`[EXPORT] Requesting ${name} (${formatBytes(size)})...`);
    const onProgress = new Channel<unknown>();
    onProgress.onmessage = (progress) => {
      const parsed = parseExportProgress(progress, exportId);
      if (exportActive.current === exportId && parsed) {
        setExportState(prev => prev && prev.exportId === exportId
          ? { ...prev, stage: parsed.stage, bytesCopied: parsed.bytesCopied, totalBytes: parsed.totalBytes }
          : prev);
      }
      // Release backpressure for this channel even if the payload was ignored.
      void invoke("acknowledge_export_progress", { exportId }).catch(() => {});
    };
    try {
      const result = await exportScanFile(scope, nodeId, exportId, onProgress);
      if (exportActive.current !== exportId) return;
      pushToast(`Saved ${result.name} (${formatBytes(result.size)})`, "success");
      addLog(`[EXPORT] Saved ${result.path} — ${formatBytes(result.size)} · sha256 ${result.sha256.slice(0, 16)}…`);
      if (result.caveat) pushToast(result.caveat, "info");
    } catch (err: unknown) {
      if (exportActive.current !== exportId) return;
      const message = err instanceof Error ? err.message : String(err);
      pushToast(message, classifyExportError(message) === "cancelled" ? "info" : "error");
      addLog(message === "Export cancelled" ? "[EXPORT] Cancelled." : `[ERROR] Export failed: ${message}`);
    } finally {
      if (exportActive.current === exportId) {
        exportActive.current = null;
        setExportState(null);
        setExportCancelling(false);
      }
      actionPending.current = false;
      setBusy(false);
    }
  }, [pushToast, addLog]);

  const handleCancelExport = useCallback(async () => {
    const exportId = exportActive.current;
    if (!exportId) return;
    setExportCancelling(true);
    try {
      await cancelExport(exportId);
    } catch (err) {
      pushToast(String(err), "error");
      setExportCancelling(false);
    }
  }, [pushToast]);

  return {
    phase, deviceSelection, selectedSerial, rootMode, setRootMode, rootPath, setRootPath,
    scanData, busy, statusText, scanProgress, cancelScan, cancelling, confirmDelete,
    handleConnect, handleRescan, handleDisconnect, handleNuke, executeDelete, cancelDelete,
    exportState, exportCancelling, handleExport, handleCancelExport,
  };
}
