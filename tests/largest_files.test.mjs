import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const scanView = url(transpile(await readFile(new URL("../src/scanView.ts", import.meta.url), "utf8")));
const source = transpile(await readFile(new URL("../src/largestFilesSummary.ts", import.meta.url), "utf8")).replace('"./scanView"', JSON.stringify(scanView));
const { parseLargestFiles } = await import(url(source));
const expected = { generation: "scan-a", revision: 2, root_path: "/fixture", read_only: false, total_files: 2, total_size: 10 };
const row = (id, name, size) => ({ path: `/fixture/${name}`, node: {
  id, parent_id: 0, name, type: "file", size, counted: true, child_count: 0, can_delete: true,
} });
const report = () => ({ generation: "scan-a", revision: 2, limit: 25, total_files: 2,
  files: [row(2, "large.txt", 7), row(3, "empty-ish", 3)] });
const parse = (data, scope = expected, limit = 25) => parseLargestFiles(JSON.stringify(data), scope, limit);

test("valid complete and top-K responses retain exact labels and IDs", () => {
  assert.deepEqual(parse(report()).files, report().files);
  const data = { ...report(), limit: 1, files: report().files.slice(0, 1) };
  assert.equal(parse(data, expected, 1).files.length, 1);
  data.files[0].ignored = "not part of the contract";
  assert.equal(parse(data, expected, 1).files[0].ignored, undefined);
});

test("empty scans and zero-byte counted files are accepted", () => {
  assert.equal(parse({ ...report(), total_files: 0, files: [] }, { ...expected, total_files: 0, total_size: 0 }).files.length, 0);
  const data = { ...report(), total_files: 1, files: [row(1, "zero", 0)] };
  assert.equal(parse(data, { ...expected, total_files: 1, total_size: 0 }).files[0].node.size, 0);
});

test("malformed payloads, row collections and unexpected workload totals are rejected", () => {
  for (const raw of ["{", "null", "[]", "5"]) assert.throws(() => parseLargestFiles(raw, expected, 25));
  for (const files of [null, {}, [], [null], [report().files[0]], [null, report().files[1]], [{ node: null, path: "/fixture/large.txt" }, report().files[1]]]) assert.throws(() => parse({ ...report(), files }));
  assert.throws(() => parse({ ...report(), files: Array(101).fill(report().files[0]) }));
  for (const changes of [{ generation: "old" }, { revision: 1 }, { revision: -1 }, { limit: 50 }, { total_files: 3 }]) {
    assert.throws(() => parse({ ...report(), ...changes }));
  }
  for (const limit of [0, 101, 1.5, NaN]) assert.throws(() => parse({ ...report(), limit }, expected, limit));
});

test("invalid or duplicate node IDs, parents and regular-file metadata are rejected", () => {
  for (const change of [
    node => { node.id = 0; }, node => { node.id = 0x1_0000_0000; }, node => { node.parent_id = null; },
    node => { node.parent_id = node.id; }, node => { node.id = 3; }, node => { node.type = "directory"; },
    node => { node.counted = false; }, node => { node.child_count = 1; }, node => { node.can_delete = "true"; },
    node => { node.size = -1; }, node => { node.size = 0.5; }, node => { node.size = Number.MAX_SAFE_INTEGER + 1; },
    node => { node.size = "7"; }, node => { node.name = null; },
  ]) {
    const data = report(); change(data.files[0].node); assert.throws(() => parse(data));
  }
});

test("sizes must be ranked, bounded and reconcile when all files are returned", () => {
  const data = report();
  data.files.reverse(); assert.throws(() => parse(data));
  assert.throws(() => parse(report(), { ...expected, total_size: 9 }));
  assert.throws(() => parse(report(), { ...expected, total_size: 11 }));
  assert.throws(() => parse({ ...report(), limit: 1, files: [row(2, "huge", 11)] }, expected, 1));
});

test("paths must match the scan root, exact name and parent shape", () => {
  for (const path of ["/another/large.txt", "/fixture-other/large.txt", "/fixture/../large.txt", "/fixture//large.txt", "/fixture/wrong.txt", "/fixture/folder/large.txt", "/fixture/large.txt\0"]) {
    const data = report(); data.files[0].path = path; assert.throws(() => parse(data));
  }
  for (const name of ["", ".", "..", "a/b", "bad\0name", "x".repeat(256), "\ud800"]) {
    const data = report(); data.files[0] = row(2, name, 7); assert.throws(() => parse(data));
  }
  const nested = report(); nested.files[0].path = "/fixture/folder/large.txt"; nested.files[0].node.parent_id = 1;
  assert.equal(parse(nested).files[0].node.parent_id, 1);
  const root = report(); root.files.forEach(file => { file.path = `/${file.node.name}`; });
  assert.equal(parse(root, { ...expected, root_path: "/" }).files.length, 2);
});

test("Unicode, BOM and whitespace labels stay exact; delimiter paths cannot offer deletion", () => {
  for (const name of [" leading trailing ", "\ufeffname", "photo-🙂", "line\nname", "line\rname"]) {
    const data = report(); data.files[0] = row(2, name, 7);
    if (/[\r\n]/.test(name)) {
      assert.throws(() => parse(data));
      data.files[0].node.can_delete = false;
    }
    assert.equal(parse(data).files[0].node.name, name);
  }
  const data = report();
  assert.throws(() => parse(data, { ...expected, read_only: true }));
  data.files.forEach(file => { file.node.can_delete = false; });
  assert.equal(parse(data, { ...expected, read_only: true }).files.length, 2);
});

test("UTF-8 path and deletion-command budgets remain distinct", () => {
  const name = "x".repeat(247);
  const file = row(2, name, 10);
  file.node.parent_id = 1;
  file.node.can_delete = false;
  file.path = `/fixture/${(`${"d".repeat(255)}/`).repeat(63)}${name}`;
  assert.equal(new TextEncoder().encode(file.path).length, 16 * 1024);
  const data = { ...report(), total_files: 1, files: [file] };
  assert.equal(parse(data, { ...expected, total_files: 1 }).files.length, 1);
  file.node.can_delete = true; assert.throws(() => parse(data, { ...expected, total_files: 1 }));
  file.node.can_delete = false; file.path += "x"; file.node.name += "x";
  assert.throws(() => parse(data, { ...expected, total_files: 1 }));
});


test("the maximum page is bounded and paths cannot be duplicated under different IDs", () => {
  const data = { ...report(), limit: 100, total_files: 100,
    files: Array.from({ length: 100 }, (_, index) => row(index + 1, `file-${index}`, 1)) };
  const scope = { ...expected, total_files: 100, total_size: 100 };
  assert.equal(parse(data, scope, 100).files.length, 100);
  data.files.push(row(101, "extra", 0));
  assert.throws(() => parse(data, scope, 100));
  const duplicate = report();
  duplicate.files[0].node.name = duplicate.files[1].node.name;
  duplicate.files[0].path = duplicate.files[1].path;
  assert.throws(() => parse(duplicate));
});
