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
    <section aria-label="Diagnostic log" id="terminal-log"
      className="h-32 shrink-0 border-t border-zinc-800 bg-zinc-950 font-mono text-[11px] text-zinc-400 flex flex-col">
      {history.discarded > 0 && <p id="log-retention-notice" className="m-0 px-4 pt-1 text-zinc-500 shrink-0">
        Showing recent logs · {history.discarded.toLocaleString("en-US")} older {history.discarded === 1 ? "entry" : "entries"} discarded.
      </p>}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2">
        {history.entries.map((log, i) => (
          <div key={history.discarded + i} className="log-entry mb-0.5 break-all">
            <span className="text-accent-500 mr-2">❯</span>
            {log}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </section>
  );
}
