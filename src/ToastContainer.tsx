import { useEffect } from "react";

export interface Toast {
  id: number;
  message: string;
  type: "error" | "success" | "info";
  exiting?: boolean;
}

export function ToastContainer({ toasts, onDismiss, onRemove }: { toasts: Toast[]; onDismiss: (id: number) => void; onRemove: (id: number) => void }) {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm" id="toast-container">
      {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} onRemove={onRemove} />)}
    </div>
  );
}

function ToastItem({ toast: t, onDismiss, onRemove }: { toast: Toast; onDismiss: (id: number) => void; onRemove: (id: number) => void }) {
  // A mounted toast owns exactly one timer; phase changes replace it and
  // unmount cancels it. Repeated dismissal cannot restart the exit deadline.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (t.exiting) onRemove(t.id); else onDismiss(t.id);
    }, t.exiting ? 300 : 5000);
    return () => clearTimeout(timer);
  }, [t.id, t.exiting, onDismiss, onRemove]);

  return (
    <div
      role={t.type === "error" ? "alert" : "status"}
      className={`
        ${t.exiting ? "animate-toast-out" : "animate-toast-in"}
        flex items-start gap-3 px-4 py-3 rounded-lg border shadow-xl cursor-pointer
        ${t.type === "error"
          ? "bg-red-950/80 border-red-800/50 text-red-200"
          : t.type === "success"
          ? "bg-emerald-950/80 border-emerald-800/50 text-emerald-200"
          : "bg-zinc-800/80 border-zinc-700/50 text-zinc-200"
        }
        backdrop-blur-md
      `}
      onClick={() => onDismiss(t.id)}
    >
      <span aria-hidden="true" className="mt-0.5 text-base">
        {t.type === "error" ? "✕" : t.type === "success" ? "✓" : "ℹ"}
      </span>
      <p className="text-sm leading-relaxed flex-1">{t.message}</p>
    </div>
  );
}
