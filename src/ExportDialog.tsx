import { useId, useLayoutEffect, useRef } from "react";
import { formatBytes } from "./formatBytes";
import type { ExportStage } from "./exportTransfer";

export function ExportDialog({ name, size, stage, bytesCopied, totalBytes, cancelling, onCancel }: {
  name: string;
  size: number;
  stage: ExportStage;
  bytesCopied: number;
  totalBytes: number;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    cancelRef.current?.focus();
    return () => { dialog.close(); };
  }, []);

  const total = totalBytes || size;
  const ratio = total > 0 ? Math.min(bytesCopied / total, 1) : 0;
  const status = stage === "committing"
    ? "Publishing the saved file…"
    : `${formatBytes(bytesCopied)} of ${formatBytes(total)} copied`;
  return <dialog ref={dialogRef} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onCancel(); }}
    className="m-auto bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-2xl p-6 max-w-sm w-[calc(100%-2rem)] shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm open:flex flex-col">
    <h3 id={titleId} className="text-lg font-bold text-zinc-100 mb-1">Saving file…</h3>
    <p className="text-sm text-zinc-300 font-mono break-all mb-3">{name}</p>
    <p id={descriptionId} role="status" aria-live="polite" className="text-xs text-zinc-400 mb-2">
      {cancelling ? "Cancelling…" : status}
    </p>
    <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden mb-5" aria-hidden="true">
      <div className="h-full bg-accent-500 transition-[width] duration-200"
        style={{ width: `${Math.round(ratio * 100)}%` }} />
    </div>
    <p className="text-[11px] text-zinc-500 mb-4">
      The file is written beside the destination and published only when complete;
      an existing file is never replaced.
    </p>
    <div className="flex justify-end">
      <button ref={cancelRef} type="button" onClick={onCancel} disabled={cancelling}
        className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-50">
        {cancelling ? "Cancelling…" : "Cancel"}
      </button>
    </div>
  </dialog>;
}
