import { formatBytes } from "./formatBytes";

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export interface ScanProgress {
  scan_id: string;
  files: number;
  directories: number;
  total_size: number;
  recent_names: string[];
}

export function ScanningScreen({ statusText, progress, onCancel, cancelling }: {
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
