import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const scanView = url(transpile(await readFile(new URL("../src/scanView.ts", import.meta.url), "utf8")));
const source = transpile(await readFile(new URL("../src/fileTypeSummary.ts", import.meta.url), "utf8")).replace('"./scanView"', JSON.stringify(scanView));
const { FILE_TYPES, parseFileTypes } = await import(url(source));
const expected = { generation: "scan-a", revision: 2, total_files: 3, total_size: 15 };
const report = () => ({ ...expected, categories: FILE_TYPES.map(kind => ({ kind,
  files: kind === "images" ? 1 : kind === "no_extension" ? 2 : 0,
  size: kind === "images" ? 5 : kind === "no_extension" ? 10 : 0 })) });
const parse = (data, scope = expected) => parseFileTypes(JSON.stringify(data), scope);

test("valid file-type summaries reconcile and use canonical category order", () => {
  const input = report();
  input.categories.reverse();
  const result = parse(input);
  assert.deepEqual(result.categories.map(row => row.kind), FILE_TYPES);
  assert.equal(result.categories.reduce((sum, row) => sum + row.files, 0), 3);
  assert.equal(result.categories.reduce((sum, row) => sum + row.size, 0), 15);
});

test("empty scans and counted zero-byte files remain distinct", () => {
  const empty = { ...expected, total_files: 0, total_size: 0,
    categories: FILE_TYPES.map(kind => ({ kind, files: 0, size: 0 })) };
  assert.equal(parse(empty, empty).total_files, 0);
  empty.categories[0].files = 1;
  empty.total_files = 1;
  assert.equal(parse(empty, empty).categories[0].size, 0);
});

test("stale scopes and summaries from a different counted workload are rejected", () => {
  for (const changes of [{ generation: "old" }, { revision: 1 }, { total_files: 4 }, { total_size: 16 }]) {
    assert.throws(() => parse({ ...report(), ...changes }), /does not match/);
  }
});

test("missing, duplicate, unknown and oversized category sets are rejected", () => {
  for (const change of [
    rows => rows.pop(),
    rows => rows.push(rows[0]),
    rows => { rows[1] = { ...rows[0] }; },
    rows => { rows[0].kind = "unknown"; },
    rows => { rows[0].kind = "__proto__"; },
    rows => { rows[0] = null; },
  ]) {
    const input = report();
    change(input.categories);
    assert.throws(() => parse(input));
  }
});

test("invalid counts, byte values and non-reconciling category totals are rejected", () => {
  for (const field of ["files", "size"]) for (const value of [-1, 0.5, null, "5", Number.MAX_SAFE_INTEGER + 1]) {
    const input = report();
    input.categories[0][field] = value;
    assert.throws(() => parse(input));
  }
  for (const change of [
    input => { input.categories[0].files++; },
    input => { input.categories[0].size++; },
    input => { input.categories[0] = { kind: "images", files: 0, size: 5 }; },
    input => {
      input.total_size = Number.MAX_SAFE_INTEGER;
      input.categories[0].size = Number.MAX_SAFE_INTEGER;
    },
  ]) {
    const input = report();
    change(input);
    assert.throws(() => parse(input, { ...expected, total_size: input.total_size }));
  }
});

test("malformed JSON and non-object payloads fail at the query boundary", () => {
  for (const raw of ["{", "null", "[]", "5", '"text"']) assert.throws(() => parseFileTypes(raw, expected));
});
