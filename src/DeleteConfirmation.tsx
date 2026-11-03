import { useId, useLayoutEffect, useRef } from "react";
import { IconNuke } from "./Icons";

export function DeleteConfirmation({ path, trigger, onCancel, onConfirm }: {
  path: string;
  trigger: HTMLButtonElement;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pathRef = useRef<HTMLParagraphElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    cancelRef.current?.focus();
    // The detail request can finish after focus has moved away from Delete.
    return () => {
      dialog.close();
      if (trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [trigger]);

  return <dialog ref={dialogRef} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); onCancel(); }}
    onKeyDown={event => {
      if (event.key !== "Tab") return;
      if (event.shiftKey && document.activeElement === pathRef.current) {
        event.preventDefault();
        confirmRef.current?.focus();
      } else if (!event.shiftKey && document.activeElement === confirmRef.current) {
        event.preventDefault();
        pathRef.current?.focus();
      }
    }}
    className="m-auto bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-2xl p-6 max-w-sm w-[calc(100%-2rem)] max-h-[calc(100vh-2rem)] open:flex flex-col overflow-y-auto shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm">
    <div className="flex items-center gap-3 mb-4 shrink-0">
      <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center text-red-500">
        <IconNuke />
      </div>
      <h3 id={titleId} className="text-lg font-bold text-zinc-100">Delete Item?</h3>
    </div>
    <p id={descriptionId} className="text-sm text-zinc-400 mb-2 shrink-0">
      Are you sure you want to permanently delete:
    </p>
    <p ref={pathRef} tabIndex={0} className="min-h-0 overflow-y-auto focus-visible:outline-2 focus-visible:outline-accent-400 text-sm font-mono text-zinc-300 bg-zinc-950 p-2 rounded-lg whitespace-break-spaces break-all border border-zinc-800 mb-6">
      {path}
    </p>
    <div className="flex items-center gap-3 justify-end shrink-0">
      <button ref={cancelRef} type="button" onClick={onCancel}
        className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
        Cancel
      </button>
      <button ref={confirmRef} type="button" onClick={onConfirm}
        className="px-4 py-2 rounded-lg text-sm font-bold bg-red-600 hover:bg-red-500 text-white transition-colors shadow-lg shadow-red-500/20">
        NUKE IT
      </button>
    </div>
  </dialog>;
}
