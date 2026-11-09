import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

const source = await readFile(new URL("../src/exportTransfer.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } });
const { parseExportProgress, parseExportResult, classifyExportError } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

const EXPORT_ID = "e-1234";
const progress = (overrides = {}) => ({
  export_id: EXPORT_ID, stage: "transferring", bytes_copied: 4096, total_bytes: 67108864, ...overrides,
});

test("accepts well-formed progress payloads with a matching export id", () => {
  for (const stage of ["transferring", "committing"]) {
    const parsed = parseExportProgress(progress({ stage }), EXPORT_ID);
    assert.deepEqual(parsed, { exportId: EXPORT_ID, stage, bytesCopied: 4096, totalBytes: 67108864 });
  }
});

test("rejects foreign, malformed, or lying progress payloads", () => {
  assert.equal(parseExportProgress(progress(), "other-id"), null);
  assert.equal(parseExportProgress(progress({ export_id: 7 }), EXPORT_ID), null);
  assert.equal(parseExportProgress(progress({ stage: "verifying" }), EXPORT_ID), null);
  assert.equal(parseExportProgress(progress({ stage: null }), EXPORT_ID), null);
  assert.equal(parseExportProgress(progress({ bytes_copied: -1 }), EXPORT_ID), null);
  assert.equal(parseExportProgress(progress({ bytes_copied: 1.5 }), EXPORT_ID), null);
  assert.equal(parseExportProgress(progress({ bytes_copied: "4096" }), EXPORT_ID), null);
  assert.equal(parseExportProgress(progress({ total_bytes: Number.MAX_SAFE_INTEGER + 1 }), EXPORT_ID), null);
  assert.equal(parseExportProgress(null, EXPORT_ID), null);
  assert.equal(parseExportProgress("progress", EXPORT_ID), null);
  assert.equal(parseExportProgress([progress()], EXPORT_ID), null);
});

const result = (overrides = {}) => ({
  status: "saved", name: "report.pdf", path: "/tmp/report.pdf", size: 67108864,
  sha256: "a".repeat(64), caveat: null, ...overrides,
});

test("accepts a well-formed saved result including a caveat", () => {
  const caveat = "Export saved, but the directory sync failed: ENOSPC";
  const parsed = parseExportResult(result({ caveat }));
  assert.equal(parsed.name, "report.pdf");
  assert.equal(parsed.path, "/tmp/report.pdf");
  assert.equal(parsed.size, 67108864);
  assert.equal(parsed.caveat, caveat);
  assert.equal(parseExportResult(result()).caveat, null);
});

test("rejects results that are not verified saves", () => {
  const invalid = [
    result({ status: "failed" }),
    result({ status: undefined }),
    result({ name: "" }),
    result({ name: 5 }),
    result({ path: "" }),
    result({ size: -1 }),
    result({ size: 1.5 }),
    result({ sha256: "zz" }),
    result({ sha256: "a".repeat(63) }),
    result({ caveat: 9 }),
    null, "saved", [], undefined,
  ];
  for (const value of invalid) assert.throws(() => parseExportResult(value), /unexpected result/);
});

test("classifies backend error text into distinct kinds", () => {
  assert.equal(classifyExportError("Export cancelled"), "cancelled");
  assert.equal(classifyExportError("Destination already exists; choose a fresh name. Export never overwrites files."), "collision");
  assert.equal(classifyExportError("Source changed during export; rescan and retry."), "source-changed");
  assert.equal(classifyExportError("Daemon identity changed; reconnect and retry."), "stale-session");
  assert.equal(classifyExportError("The device session changed; reconnect and retry the export."), "stale-session");
  assert.equal(classifyExportError("Device connection lost during transfer. Reconnect and retry."), "stale-session");
  assert.equal(classifyExportError("Export timed out. Reconnect and retry."), "stale-session");
  assert.equal(classifyExportError("Cannot write the export staging file: ENOSPC"), "failed");
});
