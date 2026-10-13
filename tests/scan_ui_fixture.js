// Real built frontend, mocked Tauri IPC. No native app, ADB or device calls.
(() => {
  const calls = [];
  let generation = 1;
  let revision = 0;
  let unavailable = false;
  let readOnly = false;
  let delayedZoom = true;
  let delayedDetail = true;
  let failDelete = false;
  let callbacks = 0;
  let rootChildren;
  let folderChildren;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const node = (id, parent_id, name, size, directory = false) => ({
    id, parent_id, name, size, type: directory ? "directory" : "file", counted: true,
    child_count: directory ? 200 : 0, can_delete: id !== 0 && !readOnly,
  });
  const reset = () => {
    folderChildren = Array.from({ length: 200 }, (_, i) => node(i + 1001, 1, `nested-${i}`, 1));
    rootChildren = [node(1, 0, "large-folder", 200, true), ...Array.from({ length: 270 }, (_, i) => node(i + 2, 0, ` file-${i} `, 1))];
    unavailable = false;
    revision = 0;
  };
  reset();
  const scope = () => ({ generation: `fixture-${generation}`, revision });
  const summary = () => ({
    ...scope(), status: "ok", root_path: "/fixture", root: { ...node(0, null, "fixture", 470 - (271 - rootChildren.length), true), child_count: rootChildren.length },
    total_files: rootChildren.length - 1 + folderChildren.length, total_dirs: 2,
    total_size: 470 - (271 - rootChildren.length), errors: 0, skipped: 0, scan_time_ms: 1, read_only: readOnly,
  });
  const detail = id => {
    const target = id === 0 ? summary().root : [...rootChildren, ...folderChildren].find(item => item.id === id);
    check(target, "Unknown mock node");
    return { ...scope(), node: target, path: `/fixture/${target.parent_id === 1 ? "large-folder/" : ""}${target.name}` };
  };
  const view = args => {
    const directory = args.nodeId === 0 ? summary().root : detail(args.nodeId).node;
    const all = args.nodeId === 0 ? rootChildren : args.nodeId === 1 ? folderChildren : [];
    let offset = 0;
    if (args.cursor) {
      const position = all.findIndex(item => item.id === args.cursor.node_id);
      offset = args.cursor.direction === "next" ? position + 1 : Math.max(0, position - 128);
    }
    const children = all.slice(offset, offset + 128);
    const chart = all.slice(0, 64).map(item => ({ node_id: item.id, name: item.name, size: item.size }));
    const remainder = directory.size - chart.reduce((sum, tile) => sum + tile.size, 0);
    if (all.length && remainder) chart.push({ node_id: null, name: "Other", size: remainder });
    return { ...scope(), node: directory, path: args.nodeId === 0 ? "/fixture" : detail(args.nodeId).path,
      breadcrumbs: args.nodeId === 0 ? [{ id: 0, name: "fixture" }] : [{ id: 0, name: "fixture" }, { id: args.nodeId, name: directory.name }],
      children, chart,
      previous_cursor: offset ? { direction: "previous", node_id: children[0].id } : null,
      next_cursor: offset + children.length < all.length ? { direction: "next", node_id: children.at(-1).id } : null,
    };
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => ++callbacks,
    unregisterCallback: () => {},
    invoke: async (command, args = {}) => {
      calls.push({ command, args });
      if (command === "check_adb") return "Mock ADB";
      if (command === "init_daemon") return "Mock daemon";
      if (command === "run_scan") { generation++; reset(); return JSON.stringify(summary()); }
      if (command === "stop_daemon") { unavailable = true; return "Mock stopped"; }
      check(!unavailable, "Snapshot unavailable");
      check(args.generation === scope().generation && args.revision === revision, "Stale mock snapshot");
      if (command === "get_scan_view") {
        const response = JSON.stringify(view(args));
        if (args.nodeId === 1 && delayedZoom) { delayedZoom = false; await pause(300); }
        return response;
      }
      if (command === "get_scan_node") {
        const response = JSON.stringify(detail(args.nodeId));
        if (delayedDetail) { delayedDetail = false; await pause(300); }
        return response;
      }
      if (command === "delete_item") {
        check(!("path" in args), "Frontend passed a destructive path");
        check(args.nodeId !== 0 && !readOnly, "Unsafe mock deletion");
        if (failDelete) { unavailable = true; throw "Partially deleted directory"; }
        const selected = detail(args.nodeId);
        rootChildren = rootChildren.filter(item => item.id !== args.nodeId);
        revision++;
        return JSON.stringify({ summary: summary(), message: "Deleted fixture item", removed: { files: 1, dirs: 0, size: selected.node.size } });
      }
      throw Error(`Unexpected IPC ${command}`);
    },
  };
  const waitFor = async (predicate, message) => {
    const end = Date.now() + 3000;
    while (!predicate()) { if (Date.now() > end) throw Error(message); await pause(20); }
  };
  const button = text => [...document.querySelectorAll("button")].find(item => item.textContent.trim() === text && !item.disabled);
  const rows = () => [...document.querySelectorAll(".file-row")];
  const zoomFolder = () => [...rows().find(item => item.textContent.includes("large-folder")).querySelectorAll("button")]
    .find(item => item.textContent.trim() === "Zoom").click();
  const report = (passed, error) => {
    const output = document.createElement("pre");
    output.id = "scan-test-report";
    output.textContent = JSON.stringify({ passed, error, ipc_calls: calls.length, checks: passed ? ["complete paging", "late zoom", "Other tile", "stale confirmation", "ID-only deletion", "revision refresh", "partial failure", "read-only"] : undefined });
    document.body.append(output);
    void fetch("/report", { method: "POST", body: output.textContent });
  };
  void (async () => {
    await waitFor(() => document.querySelector("#btn-connect"), "Setup did not render");
    document.querySelector("#btn-connect").click();
    await waitFor(() => rows().length === 129, "Initial page did not render 128 children");
    check(document.body.textContent.includes("128 entries on this page of 271"), "Missing full entry count");
    const firstNames = rows().map(item => item.textContent);
    button("Next").click();
    await waitFor(() => rows().some(item => item.textContent.includes("file-127")), "Next page missing");
    button("Next").click();
    await waitFor(() => rows().length === 16, "Final 15 children missing");
    button("Previous").click();
    await waitFor(() => rows().length === 129, "Previous page missing");
    button("Previous").click();
    await waitFor(() => rows().some(item => item.textContent.includes("large-folder")), "First page missing");
    check(JSON.stringify(rows().map(item => item.textContent)) === JSON.stringify(firstNames), "Paging changed ordering");

    zoomFolder();
    await waitFor(() => button("← Back to Root"), "Zoom navigation missing");
    button("← Back to Root").click();
    await waitFor(() => rows()[0]?.textContent.includes("fixture") && !button("← Back to Root"), "Root did not reload");
    // Folder expansion persists across zoom. Close it to isolate the late
    // root-view response from an independent, valid child-directory query.
    const folder = rows().find(item => item.textContent.includes("large-folder"));
    if (folder.querySelector('[aria-expanded="true"]')) folder.querySelector('[aria-expanded]').click();
    await pause(350);
    check(rows().length === 129 && !button("← Back to Root"), "Late zoom replaced root view");
    await waitFor(() => [...document.querySelectorAll("svg text")].some(item => item.textContent === "Other"), "Other tile missing");
    const before = calls.filter(item => item.command === "get_scan_view").length;
    const other = [...document.querySelectorAll("svg text")].find(item => item.textContent === "Other");
    other.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await pause(30);
    check(calls.filter(item => item.command === "get_scan_view").length === before, "Other tile zoomed");

    document.querySelector('[aria-label="Delete  file-0 "]').click();
    document.querySelector("#btn-rescan").click();
    await waitFor(() => rows().length === 129, "Rescan did not reload");
    await pause(350);
    check(!button("NUKE IT"), "Old confirmation survived rescan");
    document.querySelector('[aria-label="Delete  file-0 "]').click();
    await waitFor(() => button("NUKE IT"), "Confirmation missing");
    check(document.body.textContent.includes("/fixture/ file-0 "), "Exact confirmation path missing");
    button("NUKE IT").click();
    await waitFor(() => rows().length === 129 && !document.querySelector('[aria-label="Delete  file-0 "]'), "Deleted row survived revision refresh");
    check(calls.some(item => item.command === "delete_item" && item.args.nodeId === 2 && !("path" in item.args)), "ID-only delete was not invoked");

    zoomFolder();
    await waitFor(() => rows().some(item => item.textContent.includes("nested-0")), "Nested directory missing");
    button("Next").click();
    await waitFor(() => rows().length === 73, "Nested final page missing");
    button("← Back to Root").click();
    await waitFor(() => document.querySelector('[aria-label="Delete  file-1 "]'), "Root after zoom missing");
    failDelete = true;
    document.querySelector('[aria-label="Delete  file-1 "]').click();
    await waitFor(() => button("NUKE IT"), "Second confirmation missing");
    button("NUKE IT").click();
    await waitFor(() => document.querySelector("#btn-connect") && !document.querySelector("#btn-connect").disabled, "Partial failure did not clear results");
    check(rows().length === 0, "Invalid snapshot remained visible");
    check(calls.at(-1).command === "stop_daemon", "Partial failure did not stop session");

    failDelete = false;
    readOnly = true;
    document.querySelector("#btn-connect").click();
    await waitFor(() => rows().length === 129, "Read-only page missing");
    check(document.body.textContent.includes("Deletion disabled"), "Read-only banner missing");
    check(!document.querySelector('[aria-label^="Delete "]'), "Read-only deletion enabled");
    report(true);
  })().catch(error => report(false, error.stack));
})();
