import { useEffect, useRef } from "react";
import type { LogHistory } from "./logHistory";

// ── Terminal Log ────────────────────────────────────────────────────────────

export function TerminalLog({ history }: { history: LogHistory }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  if (history.entries.length === 0) return null;

  return (
    <details aria-label="Diagnostic log" id="terminal-log"
      className="shrink-0 border-t border-zinc-800 bg-zinc-950 font-mono text-[11px] text-zinc-400"
      onToggle={event => { if (event.currentTarget.open) endRef.current?.scrollIntoView({ block: "nearest" }); }}>
      <summary className="cursor-pointer px-4 py-2 select-none focus-visible:outline-2 focus-visible:outline-accent-400">
        Diagnostics
        <span className="ml-3 text-zinc-500">{history.entries.length.toLocaleString("en-US")} entries</span>
      </summary>
      {history.discarded > 0 && <p id="log-retention-notice" className="m-0 px-4 pt-1 text-zinc-500 shrink-0">
        Showing recent logs · {history.discarded.toLocaleString("en-US")} older {history.discarded === 1 ? "entry" : "entries"} discarded.
      </p>}
      <div className="h-32 max-h-[25vh] overflow-y-auto px-4 py-2">
        {history.entries.map((log, i) => (
          <div key={history.discarded + i} className="log-entry mb-0.5 break-all">
            <span className="text-accent-500 mr-2">❯</span>
            {log}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </details>
  );
}
