// Limits apply to diagnostic display text, never paths or command arguments.
export const MAX_LOG_ENTRIES = 500;
export const MAX_LOG_TEXT_UNITS = 128 * 1024; // 256 KiB using two bytes per UTF-16 unit.
export const MAX_LOG_ENTRY_UNITS = 4096;
const TRUNCATION_MARKER = "… [truncated]";

export interface LogHistory {
  entries: readonly string[];
  textUnits: number;
  discarded: number;
}

export function emptyLogHistory(): LogHistory {
  return { entries: [], textUnits: 0, discarded: 0 };
}

export function boundDiagnostic(message: string): string {
  if (message.length > MAX_LOG_ENTRY_UNITS) {
    let end = MAX_LOG_ENTRY_UNITS - TRUNCATION_MARKER.length;
    // Do not split an astral character at the truncation boundary.
    const last = message.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    message = message.slice(0, end) + TRUNCATION_MARKER;
  }
  // Materialize bounded text: a substring/rope can otherwise retain a much
  // larger source string. JSON round-tripping preserves UTF-16 code units.
  return JSON.parse(JSON.stringify(message)) as string;
}

export function appendLog(history: LogHistory, message: string): LogHistory {
  const entry = boundDiagnostic(message);
  let textUnits = history.textUnits + entry.length;
  let remove = 0;
  while (history.entries.length - remove + 1 > MAX_LOG_ENTRIES || textUnits > MAX_LOG_TEXT_UNITS) {
    textUnits -= history.entries[remove++].length;
  }
  return {
    entries: [...history.entries.slice(remove), entry],
    textUnits,
    discarded: history.discarded + remove,
  };
}
