import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/scanView.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
});
const { sameScan, viewKey, viewReducer, parseNodeDetail } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const scope = { generation: "scan-a", revision: 0 };
const page = (nodeId = 0, revision = 0, generation = "scan-a") => ({
  generation, revision, node: { id: nodeId }, children: [],
});

test("scope rejects disconnected, replaced and deleted snapshots", () => {
  assert.equal(sameScan(null, scope), false);
  assert.equal(sameScan(scope, scope), true);
  assert.equal(sameScan({ ...scope, generation: "scan-b" }, scope), false);
  assert.equal(sameScan({ ...scope, revision: 1 }, scope), false);
});

test("query identity distinguishes nodes, cursor direction, revisions and generations", () => {
  const keys = [
    viewKey(scope, 0, null), viewKey(scope, 1, null),
    viewKey(scope, 0, { direction: "next", node_id: 128 }),
    viewKey(scope, 0, { direction: "previous", node_id: 128 }),
    viewKey(scope, 0, { direction: "next", node_id: 256 }),
    viewKey({ ...scope, revision: 1 }, 0, null),
    viewKey({ ...scope, generation: "scan-b" }, 0, null),
  ];
  assert.equal(new Set(keys).size, keys.length);
});

test("late success and errors cannot replace a newer directory request", () => {
  let state = viewReducer({ request: 0, key: "" }, { type: "start", request: 1, key: "root" });
  state = viewReducer(state, { type: "start", request: 2, key: "folder" });
  const pending = state;
  assert.equal(viewReducer(state, { type: "success", request: 1, page: page() }), pending);
  assert.equal(viewReducer(state, { type: "error", request: 1, error: "stale failure" }), pending);
  state = viewReducer(state, { type: "success", request: 2, page: page(1) });
  assert.equal(state.page.node.id, 1);
  assert.equal(state.key, "folder");
});

test("revision refresh clears visible rows before old responses complete", () => {
  let state = viewReducer({ request: 0, key: "" }, { type: "start", request: 1, key: viewKey(scope, 0, null) });
  state = viewReducer(state, { type: "success", request: 1, page: page() });
  state = viewReducer(state, { type: "start", request: 2, key: viewKey({ ...scope, revision: 1 }, 0, null) });
  assert.equal(state.page, undefined);
  assert.equal(state.error, undefined);
  const waiting = state;
  assert.equal(viewReducer(state, { type: "success", request: 1, page: page() }), waiting);
  state = viewReducer(state, { type: "success", request: 2, page: page(0, 1) });
  assert.equal(state.page.revision, 1);
});

test("page navigation A-B-A still rejects the first A response", async () => {
  let resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  let state = { request: 0, key: "" };
  const complete = first.then(value => { state = viewReducer(state, { type: "success", request: 1, page: value }); });
  for (const [request, key] of [[1, "A"], [2, "B"], [3, "A"]]) {
    state = viewReducer(state, { type: "start", request, key });
  }
  resolveFirst(page(0));
  await complete;
  assert.equal(state.page, undefined);
  state = viewReducer(state, { type: "success", request: 3, page: page(0, 1) });
  assert.equal(state.page.revision, 1);
});

test("retry clears the error and ignores the prior failure", () => {
  let state = viewReducer({ request: 0, key: "" }, { type: "start", request: 1, key: "root" });
  state = viewReducer(state, { type: "error", request: 1, error: "connection lost" });
  assert.equal(state.error, "connection lost");
  state = viewReducer(state, { type: "start", request: 2, key: "root" });
  assert.equal(state.error, undefined);
  const pending = state;
  assert.equal(viewReducer(state, { type: "error", request: 1, error: "old error" }), pending);
});

const detailScope = { ...scope, root_path: "/sdcard", read_only: false, total_size: 100 };
const detail = () => ({ ...scope, path: "/sdcard/photo.jpg", node: {
  id: 1, parent_id: 0, name: "photo.jpg", type: "file", size: 100,
  counted: true, child_count: 0, can_delete: true,
} });
const parseDetail = (value, expected = detailScope, id = 1) => parseNodeDetail(JSON.stringify(value), expected, id);

test("node detail accepts files, directories, exact labels and uncounted special entries", () => {
  assert.deepEqual(parseDetail(detail()), detail());
  for (const name of [" file ", "\ufeffphoto.jpg", "photo-😀.jpg"]) {
    const value = detail(); value.node.name = name; value.path = `/sdcard/${name}`;
    assert.deepEqual(parseDetail(value), value);
  }
  const folder = detail(); folder.node.type = "directory"; folder.node.child_count = 3;
  assert.deepEqual(parseDetail(folder), folder);
  const special = detail(); special.node.counted = false; special.node.size = 0;
  assert.deepEqual(parseDetail(special), special);
  const root = detail(); root.node = { ...root.node, id: 0, parent_id: null, name: "sdcard", type: "directory", can_delete: false }; root.path = "/sdcard";
  assert.deepEqual(parseDetail(root, detailScope, 0), root);
  root.node.name = "/"; root.path = "/";
  assert.deepEqual(parseDetail(root, { ...detailScope, root_path: "/" }, 0), root);
});

test("node detail rejects stale scopes and a different requested ID", () => {
  assert.throws(() => parseDetail({ ...detail(), generation: "scan-b" }));
  assert.throws(() => parseDetail({ ...detail(), revision: 1 }));
  assert.throws(() => parseDetail(detail(), detailScope, 2));
  assert.throws(() => parseDetail(detail(), detailScope, -1));
});

test("node detail rejects malformed records, IDs, counts and node kinds", () => {
  for (const value of [null, [], {}, { ...detail(), node: null }, { ...detail(), path: {} }]) assert.throws(() => parseDetail(value));
  for (const [field, value] of [
    ["id", -1], ["id", 2 ** 32], ["parent_id", null], ["parent_id", 1],
    ["size", -1], ["size", 101], ["size", 0.5], ["child_count", 1],
    ["counted", "true"], ["can_delete", "true"], ["name", {}], ["type", "symlink"],
    ["counted", false],
  ]) assert.throws(() => parseDetail({ ...detail(), node: { ...detail().node, [field]: value } }), field);
});

test("node detail rejects misleading paths and unsafe deletion flags", () => {
  for (const path of ["/elsewhere/photo.jpg", "/sdcard2/photo.jpg", "/sdcard/other.jpg", "/sdcard/../photo.jpg", "/sdcard//photo.jpg", "/sdcard/folder/photo.jpg"]) {
    assert.throws(() => parseDetail({ ...detail(), path }), path);
  }
  for (const name of [".", "..", "a/b", "a\0b", "\ud800", "x".repeat(256), "photo\n.jpg"]) {
    assert.throws(() => parseDetail({ ...detail(), path: `/sdcard/${name}`, node: { ...detail().node, name } }));
  }
  const newline = detail(); newline.node.name = "photo\n.jpg"; newline.path = `/sdcard/${newline.node.name}`; newline.node.can_delete = false;
  assert.deepEqual(parseDetail(newline), newline);
  assert.throws(() => parseDetail(detail(), { ...detailScope, read_only: true }));
  const readOnly = detail(); readOnly.node.can_delete = false;
  assert.deepEqual(parseDetail(readOnly, { ...detailScope, read_only: true }), readOnly);
});
