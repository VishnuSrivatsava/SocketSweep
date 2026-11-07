import { useState, useCallback } from "react";
import { DeleteConfirmation } from "./DeleteConfirmation";
import { ExportDialog } from "./ExportDialog";
import { ToastContainer } from "./ToastContainer";
import { useToasts } from "./useToasts";
import { TerminalLog } from "./TerminalLog";
import { appendLog, emptyLogHistory } from "./logHistory";
import { ScanningScreen } from "./ScanningScreen";
import { SetupScreen } from "./SetupScreen";
import { ResultScreen } from "./ResultScreen";
import { useScanSession } from "./useScanSession";
import "./App.css";

function App() {
  const { toasts, pushToast, dismissToast, removeToast } = useToasts();
  const [logs, setLogs] = useState(emptyLogHistory);
  const addLog = useCallback((msg: string) => {
    const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
    setLogs(prev => appendLog(prev, entry));
  }, []);
  const {
    phase, deviceSelection, selectedSerial, rootMode, setRootMode, rootPath, setRootPath,
    scanData, busy, statusText, scanProgress, cancelScan, cancelling, confirmDelete,
    handleConnect, handleRescan, handleDisconnect, handleNuke, executeDelete, cancelDelete,
    exportState, exportCancelling, handleExport, handleCancelExport,
  } = useScanSession(pushToast, addLog);

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
        {phase === "scanning" && <ScanningScreen statusText={statusText} progress={scanProgress} onCancel={cancelScan} cancelling={cancelling} />}
        {phase === "result" && scanData && (
          <ResultScreen
            key={scanData.generation}
            data={scanData}
            deviceSerial={selectedSerial}
            busy={busy}
            onRescan={handleRescan}
            onDisconnect={handleDisconnect}
            onNuke={handleNuke}
            onExport={handleExport}
          />
        )}
      </div>

      <TerminalLog history={logs} />

      {confirmDelete && <DeleteConfirmation
        path={confirmDelete.path}
        trigger={confirmDelete.trigger}
        onCancel={cancelDelete}
        onConfirm={executeDelete}
      />}
      {exportState && <ExportDialog
        name={exportState.name}
        size={exportState.size}
        stage={exportState.stage}
        bytesCopied={exportState.bytesCopied}
        totalBytes={exportState.totalBytes}
        cancelling={exportCancelling}
        onCancel={handleCancelExport}
      />}
    </div>
  );
}

export default App;
