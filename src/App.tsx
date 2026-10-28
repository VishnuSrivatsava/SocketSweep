import { useState, useCallback, useRef } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { formatBytes } from "./formatBytes";
import { sameScan } from "./scanView";
import type { ScanResponse, NodeDetail, DeleteResult } from "./scanView";
import { IconNuke } from "./Icons";
import { ToastContainer } from "./ToastContainer";
import type { Toast } from "./ToastContainer";
import { TerminalLog } from "./TerminalLog";
import { appendLog, emptyLogHistory } from "./logHistory";
import { useDevices } from "./useDevices";
import { SetupScreen } from "./SetupScreen";
import { ResultScreen } from "./ResultScreen";
import "./App.css";

// ── Types ───────────────────────────────────────────────────────────────────

/** One-line phase breakdown for the terminal log; null if the daemon predates #3. */
const scanPhaseLog = (r: ScanResponse): string | null => {
  if (r.traverse_ms === undefined) return null;
  const kb = r.bytes_sent !== undefined ? `, ${(r.bytes_sent / 1024).toFixed(0)} KB sent` : "";
  return `[SCAN] ${r.streamed ? "Stream timings (overlap): scan" : "Phases: traverse"} ${r.traverse_ms}ms · sort ${r.sort_ms}ms · serialize ${r.serialize_ms}ms · send ${r.send_ms}ms${kb}`;
};

type AppPhase = "setup" | "connecting" | "scanning" | "result";

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// ── Toast System ────────────────────────────────────────────────────────────

let toastId = 0;

// ── Scanning Screen ─────────────────────────────────────────────────────────

interface ScanProgress {
  scan_id: string;
  files: number;
  directories: number;
  total_size: number;
  recent_names: string[];
}

function ScanningScreen({ statusText, progress, onCancel, cancelling }: {
  statusText: string; progress: ScanProgress | null; onCancel: () => void; cancelling: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-8 animate-fade-in-up">
      <div className="relative w-32 h-32">
        <div className="absolute inset-0 rounded-full border-2 border-accent-500/20" />
        <svg className="absolute inset-0 animate-spin" style={{ animationDuration: "2s" }} viewBox="0 0 128 128">
          <circle cx="64" cy="64" r="62" fill="none" stroke="url(#scanGrad)" strokeWidth="2.5"
            strokeLinecap="round" strokeDasharray="120 280" />
          <defs>
            <linearGradient id="scanGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="oklch(0.60 0.18 180)" />
              <stop offset="100%" stopColor="oklch(0.60 0.18 180 / 0)" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-16 h-16 rounded-xl bg-accent-500/10 border border-accent-500/20 flex items-center justify-center scan-shimmer">
            <span className="text-accent-400 text-xl">⚡</span>
          </div>
        </div>
      </div>

      <div className="text-center">
        <h2 className="text-lg font-semibold text-zinc-200">Scanning Storage</h2>
        <p className="mt-1 text-sm text-zinc-500 font-mono">{statusText}</p>
        {progress && (
          <div className="mt-4 space-y-2" aria-live="polite">
            <p className="text-sm text-zinc-300">
              {formatNumber(progress.files)} files · {formatNumber(progress.directories)} directories · {formatBytes(progress.total_size)} found
            </p>
            <p className="text-xs text-zinc-500">Partial results — totals may increase</p>
            <ul className="text-xs text-zinc-400 max-w-sm mx-auto space-y-1">
              {progress.recent_names.map((name, index) => <li className="truncate" key={index}>{name}</li>)}
            </ul>
          </div>
        )}
        <button onClick={onCancel} disabled={cancelling}
          className="mt-5 px-4 py-2 rounded-lg text-sm bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">
          {cancelling ? "Cancelling…" : "Cancel scan"}
        </button>
      </div>
    </div>
  );
}

// ── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [phase, setPhase] = useState<AppPhase>("setup");
  const deviceSelection = useDevices(phase === "setup");
  const { serial: selectedSerial, ready: deviceReady } = deviceSelection;
  const [rootMode, setRootMode] = useState(false);
  const [rootPath, setRootPath] = useState("/data");
  const [scanData, setScanData] = useState<ScanResponse | null>(null);
  const snapshot = useRef<ScanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const confirmationRequest = useRef(0);
  const [confirmDelete, setConfirmDelete] = useState<NodeDetail | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const activeScan = useRef<string | null>(null);
  const [statusText, setStatusText] = useState("Initializing…");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [logs, setLogs] = useState(emptyLogHistory);

  const addLog = useCallback((msg: string) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    setLogs((prev) => appendLog(prev, entry));
  }, []);

  // ── Toast helpers ───────────────────────────────────────────────────────
  const pushToast = useCallback((message: string, type: Toast["type"] = "error") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) =>
      prev.map((t) => (t.id === id && !t.exiting ? { ...t, exiting: true } : t))
    );
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const requestScan = useCallback(async (path: string): Promise<ScanResponse> => {
    snapshot.current = null;
    confirmationRequest.current += 1;
    setConfirmDelete(null);
    const scanId = crypto.randomUUID();
    activeScan.current = scanId;
    setScanProgress(null);
    setCancelling(false);
    const onProgress = new Channel<ScanProgress>();
    onProgress.onmessage = (progress) => {
      if (activeScan.current === scanId && progress.scan_id === scanId) setScanProgress(progress);
      void invoke("acknowledge_scan_progress", { scanId: progress.scan_id }).catch(() => {
        // The completed/cancelled scan may already have released its channel.
      });
    };
    try {
      const raw = await invoke<string>("run_scan", { path, scanId, onProgress });
      const parsed: ScanResponse = JSON.parse(raw);
      if (parsed.status !== "ok") throw new Error("Scan returned non-ok status");
      return parsed;
    } finally {
      if (activeScan.current === scanId) activeScan.current = null;
      setCancelling(false);
    }
  }, []);

  const handleCancelScan = useCallback(async () => {
    const scanId = activeScan.current;
    if (!scanId) return;
    setCancelling(true);
    try { await invoke("cancel_scan", { scanId }); }
    catch (err) { pushToast(String(err), "error"); setCancelling(false); }
  }, [pushToast]);

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
      const adbVersion = await invoke<string>("check_adb");
      addLog(`[ADB] Found: ${adbVersion}`);

      setStatusText(rootMode ? "Requesting root access…" : "Pushing daemon to device…");
      addLog(`[ADB] Starting an owned daemon session on ${selectedSerial}...`);
      await invoke<string>("init_daemon", { serial: selectedSerial, rootMode });
      initialized = true;
      addLog("[SOCKET] Daemon started and connected via TCP tunnel!");

      setPhase("scanning");
      setStatusText(`Scanning ${scanPath} …`);
      addLog(`[SCAN] Requesting ${scanPath}${rootMode ? " with read-only root access" : ""}...`);
      const parsed = await requestScan(scanPath);

      if (parsed.status !== "ok") throw new Error("Scan returned non-ok status");

      snapshot.current = parsed;
      setScanData(parsed);
      setPhase("result");
      addLog(`[SCAN] Complete! ${parsed.total_files} files, ${parsed.scan_time_ms}ms.`);
      const phases = scanPhaseLog(parsed);
      if (phases) addLog(phases);
    } catch (err: unknown) {
      if (initialized) {
        try { await invoke<string>("stop_daemon"); } catch { /* show the original connection error */ }
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
      try { await invoke("stop_daemon"); } catch { /* retain the scan error */ }
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
      const raw = await invoke<string>("stop_daemon");
      let response;
      try { response = JSON.parse(raw); }
      catch { throw new Error("Daemon did not acknowledge shutdown"); }
      if (response?.status !== "ok" || response?.message !== "shutting down") {
        throw new Error("Daemon did not acknowledge shutdown");
      }
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
  const handleNuke = useCallback(async (nodeId: number) => {
    const scope = snapshot.current;
    if (!scope || scope.read_only || actionPending.current) return;
    const request = ++confirmationRequest.current;
    try {
      const raw = await invoke<string>("get_scan_node", { generation: scope.generation, revision: scope.revision, nodeId });
      const detail: NodeDetail = JSON.parse(raw);
      if (request === confirmationRequest.current && !actionPending.current && sameScan(snapshot.current, scope) && sameScan(detail, scope) && detail.node.id === nodeId && detail.node.can_delete) {
        setConfirmDelete(detail);
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
      const raw = await invoke<string>("delete_item", {
        generation: target.generation, revision: target.revision, nodeId: target.node.id,
      });
      if (!sameScan(snapshot.current, target)) return;
      const result: DeleteResult = JSON.parse(raw);
      if (result.summary.generation !== target.generation || result.summary.revision !== target.revision + 1) {
        throw new Error("Deletion returned an unexpected scan snapshot");
      }
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
      try { await invoke("stop_daemon"); } catch { /* retain the deletion error */ }
      setPhase("setup");
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }, [confirmDelete, pushToast, addLog]);

  return (
    <div className="h-screen flex flex-col bg-surface-0 overflow-hidden">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} onRemove={removeToast} />

      <div className="flex-1 flex flex-col min-h-0">
        {(phase === "setup" || phase === "connecting") && (
          <SetupScreen
            onConnect={handleConnect}
            loading={phase === "connecting"}
            rootMode={rootMode}
            onRootModeChange={setRootMode}
            rootPath={rootPath}
            onRootPathChange={setRootPath}
            deviceSelection={deviceSelection}
          />
        )}
        {phase === "scanning" && <ScanningScreen statusText={statusText} progress={scanProgress} onCancel={handleCancelScan} cancelling={cancelling} />}
        {phase === "result" && scanData && (
          <ResultScreen
            key={scanData.generation}
            data={scanData}
            deviceSerial={selectedSerial}
            busy={busy}
            onRescan={handleRescan}
            onDisconnect={handleDisconnect}
            onNuke={handleNuke}
          />
        )}
      </div>

      <TerminalLog history={logs} />

      {/* Custom Confirm Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in-up">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-sm w-full shadow-2xl">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center text-red-500">
                <IconNuke />
              </div>
              <h3 className="text-lg font-bold text-zinc-100">Delete Item?</h3>
            </div>
            <p className="text-sm text-zinc-400 mb-2">
              Are you sure you want to permanently delete:
            </p>
            <p className="text-sm font-mono text-zinc-300 bg-zinc-950 p-2 rounded-lg break-all border border-zinc-800 mb-6">
              {confirmDelete.path}
            </p>
            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={() => { confirmationRequest.current += 1; setConfirmDelete(null); }}
                className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={executeDelete}
                className="px-4 py-2 rounded-lg text-sm font-bold bg-red-600 hover:bg-red-500 text-white transition-colors shadow-lg shadow-red-500/20"
              >
                NUKE IT
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
