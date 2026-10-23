import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const scanView = url(transpile(await readFile(new URL("../src/scanView.ts", import.meta.url), "utf8")));
const source = transpile(await readFile(new URL("../src/scanComparison.ts", import.meta.url), "utf8")).replace('"./scanView"', JSON.stringify(scanView));
const { parseScanComparison } = await import(url(source));
const expected = { generation: "scan-a", revision: 2, total_files: 100, total_dirs: 10, total_size: 4096 };
const comparison = () => ({
  ...expected,
  first: false,
  previous: { recorded_at: 1700000000, total_files: 90, total_dirs: 12, total_size: 3072 },
  delta: { files: 10, dirs: -2, size: 1024 },
});
const parse = (data, scope = expected) => parseScanComparison(JSON.stringify(data), scope);

test("valid comparisons reconcile previous totals with the live snapshot", () => {
  const result = parse(comparison());
  assert.equal(result.first, false);
  assert.equal(result.previous.total_size, 3072);
  assert.equal(result.delta.size, 1024);
  assert.deepEqual(
    [result.previous.total_files + result.delta.files, result.previous.total_dirs + result.delta.dirs, result.previous.total_size + result.delta.size],
    [expected.total_files, expected.total_dirs, expected.total_size],
  );
});

test("first scans carry no previous totals or deltas", () => {
  const result = parse({ ...expected, first: true, previous: null, delta: null });
  assert.equal(result.first, true);
  assert.equal(result.previous, undefined);
  assert.equal(result.delta, undefined);
  for (const extra of [{ previous: comparison().previous }, { delta: comparison().delta }, { previous: undefined }, { delta: undefined }]) {
    assert.throws(() => parse({ ...expected, first: true, previous: null, delta: null, ...extra }), /does not match/);
  }
});

test("stale scopes and generations are rejected", () => {
  for (const change of [{ generation: "old" }, { revision: 1 }, { revision: -1 }]) {
    assert.throws(() => parse({ ...comparison(), ...change }), /does not match/);
  }
});

test("non-reconciling deltas are rejected", () => {
  for (const change of [
    data => { data.delta.files++; },
    data => { data.delta.dirs--; },
    data => { data.delta.size = 0; },
    data => { data.previous.total_size = 0; },
    data => { data.previous.total_files = expected.total_files; },
  ]) {
    const input = comparison();
    change(input);
    assert.throws(() => parse(input), /does not match/);
  }
});

test("invalid numbers, timestamps and shapes are rejected", () => {
  for (const field of ["total_files", "total_dirs", "total_size"]) for (const value of [-1, 0.5, null, "5", Number.MAX_SAFE_INTEGER + 1]) {
    const input = comparison();
    input.previous[field] = value;
    input.delta[field === "total_size" ? "size" : field === "total_files" ? "files" : "dirs"] = expected[field] - (value >= 0 && Number.isInteger(value) ? value : 0);
    assert.throws(() => parse(input), /does not match/);
  }
  for (const value of [0, -1, 0.5, 8_640_000_000_001, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parse({ ...comparison(), previous: { ...comparison().previous, recorded_at: value } }), /does not match/);
  }
  for (const change of [
    data => { delete data.first; },
    data => { data.first = "yes"; },
    data => { data.previous = null; },
    data => { data.delta = { files: 1, dirs: 0 }; },
    data => { data.delta = { files: 1.5, dirs: 0, size: 0 }; },
  ]) {
    const input = comparison();
    change(input);
    assert.throws(() => parse(input), /does not match/);
  }
});

test("malformed JSON and non-object payloads fail at the query boundary", () => {
  for (const raw of ["{", "null", "[]", "5", '"text"']) assert.throws(() => parseScanComparison(raw, expected));
});


test("production first-scan wire fixture is accepted", async () => {
  const raw = await readFile(new URL("fixtures/scan-history-first.json", import.meta.url), "utf8");
  assert.equal(parseScanComparison(raw, { ...expected, generation: "generation-b", revision: 0 }).first, true);
});
