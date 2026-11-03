import { useCallback, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { parseScanSummary } from "./scanView";
import type { ScanResponse } from "./scanView";

export interface ScanProgress {
  scan_id: string;
  files: number;
  directories: number;
  total_size: number;
  recent_names: string[];
}

export function useScanRequest(onError: (message: string) => void) {
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const activeScan = useRef<string | null>(null);

  const runScan = useCallback(async (path: string): Promise<ScanResponse> => {
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
