import { useCallback, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { parseScanProgress, parseScanSummary } from "./scanView";
import type { ScanProgress, ScanResponse } from "./scanView";

export function useScanRequest(onError: (message: string) => void) {
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const activeScan = useRef<string | null>(null);

  const runScan = useCallback(async (path: string): Promise<ScanResponse> => {
    const scanId = crypto.randomUUID();
    activeScan.current = scanId;
    setScanProgress(null);
    setCancelling(false);
    const onProgress = new Channel<unknown>();
    onProgress.onmessage = (progress) => {
      const parsed = parseScanProgress(progress, scanId);
      if (activeScan.current === scanId && parsed) setScanProgress(parsed);
      // Release backpressure for this channel even if its payload was ignored.
      void invoke("acknowledge_scan_progress", { scanId }).catch(() => {
        // The scan may have already finished.
      });
    };
    try {
      const raw = await invoke<string>("run_scan", { path, scanId, onProgress });
      return parseScanSummary(JSON.parse(raw));
    } finally {
      if (activeScan.current === scanId) activeScan.current = null;
      setCancelling(false);
    }
  }, []);

  const cancelScan = useCallback(async () => {
    const scanId = activeScan.current;
    if (!scanId) return;
    setCancelling(true);
    try { await invoke("cancel_scan", { scanId }); }
    catch (err) { onError(String(err)); setCancelling(false); }
  }, [onError]);

  return { scanProgress, cancelling, runScan, cancelScan };
}
