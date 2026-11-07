// Validation layer for single-file export IPC. Progress payloads from the
// backend channel and the final result string enter React state only through
// these parsers, mirroring the scanView.ts discipline: anything malformed is
// rejected, never thrown into a channel handler.

export interface ExportScope {
  generation: string;
  revision: number;
}

export type ExportStage = "transferring" | "committing";

export interface ExportProgress {
  exportId: string;
  stage: ExportStage;
  bytesCopied: number;
  totalBytes: number;
}

export interface ExportResult {
  name: string;
  path: string;
  size: number;
  sha256: string;
  caveat: string | null;
}

const STAGES: readonly ExportStage[] = ["transferring", "committing"];

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Returns the parsed progress, or null for any foreign or malformed payload. */
export function parseExportProgress(value: unknown, exportId: string): ExportProgress | null {
  const record = plainObject(value);
  if (!record || record.export_id !== exportId) return null;
  const stage = STAGES.find(candidate => candidate === record.stage);
  const bytesCopied = safeCount(record.bytes_copied);
  const totalBytes = safeCount(record.total_bytes);
  if (!stage || bytesCopied === null || totalBytes === null) return null;
  return { exportId, stage, bytesCopied, totalBytes };
}

/** Parses the saved result; throws on any shape the backend must never send. */
export function parseExportResult(value: unknown): ExportResult {
  const record = plainObject(value);
  const name = typeof record?.name === "string" ? record.name : "";
  const path = typeof record?.path === "string" ? record.path : "";
  const size = safeCount(record?.size);
  const sha256 = typeof record?.sha256 === "string" ? record.sha256 : "";
  const caveatRaw = record?.caveat;
  const caveatMissing = caveatRaw === null || caveatRaw === undefined;
  const caveat = caveatMissing ? null : typeof caveatRaw === "string" && caveatRaw.length > 0 ? caveatRaw : null;
  if (record?.status !== "saved" || !name || !path || size === null || !/^[0-9a-f]{64}$/.test(sha256)
    || (!caveatMissing && caveat === null)) {
    throw new Error("Export returned an unexpected result");
  }
  return { name, path, size, sha256, caveat };
}

export type ExportErrorKind = "cancelled" | "collision" | "stale-session" | "source-changed" | "failed";

/** Classifies backend error text so toasts and log lines can be specific. */
export function classifyExportError(message: string): ExportErrorKind {
  if (message === "Export cancelled") return "cancelled";
  if (message.startsWith("Destination already exists")) return "collision";
  if (message.startsWith("Source changed during export")) return "source-changed";
  // Every session-loss variant instructs a reconnect: daemon identity changed,
  // session changed/ended, connection lost (idle and mid-transfer), timeout.
  if (message.includes("econnect and retry")) return "stale-session";
  return "failed";
}
