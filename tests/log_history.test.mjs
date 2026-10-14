import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/logHistory.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { appendLog, emptyLogHistory, MAX_LOG_ENTRIES, MAX_LOG_TEXT_UNITS, MAX_LOG_ENTRY_UNITS } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

function verify(history) {
  assert.ok(history.entries.length <= MAX_LOG_ENTRIES);
  assert.ok(history.textUnits <= MAX_LOG_TEXT_UNITS);
  assert.equal(history.textUnits, history.entries.reduce((sum, entry) => sum + entry.length, 0));
  assert.ok(history.entries.every(entry => entry.length <= MAX_LOG_ENTRY_UNITS));
}

test("history starts empty and preserves timestamps, Unicode and chronological order", () => {
  const empty = emptyLogHistory();
  assert.deepEqual(empty, { entries: [], textUnits: 0, discarded: 0 });
  let history = appendLog(empty, "[12:00:00] [SCAN] /sdcard/照片/😀");
  history = appendLog(history, "[12:00:01] [ERROR] No Android device detected");
  assert.deepEqual(history.entries, ["[12:00:00] [SCAN] /sdcard/照片/😀", "[12:00:01] [ERROR] No Android device detected"]);
  verify(history);
});

test("entry count evicts oldest diagnostics and retains the latest shutdown/error", () => {
  let history = emptyLogHistory();
  for (let i = 0; i < 1500; i++) history = appendLog(history, `[${i}] [SCAN] Complete`);
  history = appendLog(history, "[1500] [SOCKET] App disconnected; daemon shutdown could not be confirmed: No Android device detected");
  assert.equal(history.entries.length, MAX_LOG_ENTRIES);
  assert.equal(history.discarded, 1501 - MAX_LOG_ENTRIES);
  assert.equal(history.entries[0], `[${1501 - MAX_LOG_ENTRIES}] [SCAN] Complete`);
  assert.match(history.entries.at(-1), /shutdown could not be confirmed/);
  verify(history);
});

test("text budget bounds long messages independently of entry count", () => {
  let history = emptyLogHistory();
  const count = Math.floor(MAX_LOG_TEXT_UNITS / MAX_LOG_ENTRY_UNITS) + 1;
  for (let i = 0; i < count; i++) history = appendLog(history, String(i).padEnd(MAX_LOG_ENTRY_UNITS, "x"));
  assert.equal(history.discarded, 1);
  assert.equal(history.entries.length, count - 1);
  assert.ok(history.entries.length < MAX_LOG_ENTRIES);
  verify(history);
});

test("one append can evict multiple old entries to satisfy the text budget", () => {
  let history = emptyLogHistory();
  for (let i = 0; i < MAX_LOG_ENTRIES; i++) history = appendLog(history, "x".repeat(262));
  const next = appendLog(history, "y".repeat(MAX_LOG_ENTRY_UNITS));
  assert.ok(next.discarded > 1);
  assert.equal(next.entries.at(-1), "y".repeat(MAX_LOG_ENTRY_UNITS));
  verify(next);
});

test("oversized display text is marked without changing the source path", () => {
  const path = "/sdcard/" + "📁".repeat(10000) + "/important.txt";
  const message = `[12:34:56] [DELETE] Requesting deletion of ${path}...`;
  const history = appendLog(emptyLogHistory(), message);
  assert.ok(history.entries[0].startsWith("[12:34:56] [DELETE]"));
  assert.ok(history.entries[0].endsWith("… [truncated]"));
  assert.ok(path.endsWith("/important.txt") && message.endsWith("/important.txt..."));
  verify(history);
});

test("truncation never splits a surrogate pair at the boundary", () => {
  const prefix = "a".repeat(MAX_LOG_ENTRY_UNITS - "… [truncated]".length - 1);
  const history = appendLog(emptyLogHistory(), prefix + "😀" + "b".repeat(100));
  assert.equal(history.entries[0], prefix + "… [truncated]");
  verify(history);
});

test("short text retains exact code units including quotes, controls and lone surrogates", () => {
  const message = "\"\n\t\\\ud800<script>";
  assert.equal(appendLog(emptyLogHistory(), message).entries[0], message);
});

test("updates do not mutate a previous React state snapshot", () => {
  const previous = appendLog(emptyLogHistory(), "one");
  Object.freeze(previous.entries);
  Object.freeze(previous);
  const next = appendLog(previous, "two");
  assert.deepEqual(previous.entries, ["one"]);
  assert.deepEqual(next.entries, ["one", "two"]);
});

test("mixed long-session input maintains both bounds and exact discard accounting", () => {
  let history = emptyLogHistory();
  for (let i = 0; i < 10000; i++) {
    history = appendLog(history, `[${i}] ` + "😀".repeat(i % 7 === 0 ? 5000 : i % 200));
    verify(history);
    assert.equal(history.discarded + history.entries.length, i + 1);
  }
  assert.ok(history.entries.at(-1).startsWith("[9999]"));
});
