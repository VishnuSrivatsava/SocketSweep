// Real built frontend, mocked Tauri IPC. No native app, ADB or device calls.
(() => {
  const calls = [];
  const violations = [];
  document.addEventListener("securitypolicyviolation", event => violations.push(event.blockedURI));
  let generation = 1;
  let revision = 0;
  let unavailable = false;
  let readOnly = false;
  let delayedZoom = true;
  let delayedDetail = true;
  let failDelete = false;
  let stopOutcome = "acknowledged";
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
      if (command === "stop_daemon") {
        await pause(150);
        unavailable = true;
        if (stopOutcome === "unreachable") throw "No Android device detected";
        if (stopOutcome === "invalid") return "daemon already stopped";
        if (stopOutcome === "wrong-ack") return JSON.stringify({ status: "ok", message: "pong" });
        if (stopOutcome === "error-status") return JSON.stringify({ status: "error", message: "Authentication failed" });
        return JSON.stringify({ status: "ok", message: "shutting down" });
      }
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
    output.textContent = JSON.stringify({ fixture: "scan-ui", passed, error, ipc_calls: calls.length, checks: passed ? ["offline fonts under CSP", "setup alignment", "result fonts", "file label semantics", "complete paging", "late zoom", "Other tile", "stale confirmation", "ID-only deletion", "revision refresh", "partial failure", "read-only", "acknowledged shutdown", "unconfirmed shutdown", "reconnect", "stop action ordering", "toast dismissal integration"] : undefined });
    document.body.append(output);
    void fetch("/report", { method: "POST", body: output.textContent }).then(() => {
      if (passed) location.replace("/tests/toast_lifecycle_fixture.html");
    });
  };
  void (async () => {
    await waitFor(() => document.querySelector("#btn-connect"), "Setup did not render");
    check(!document.querySelector('link[href^="http"]'), "External resource link remains");
    // load() returns actual matching FontFace objects; check() alone can succeed
    // through fallback even when no face exists. Exercise every shipped subset.
    for (const family of ["Inter", "JetBrains Mono"]) {
      const samples = family === "Inter" ? ["SocketSweep → —", "Łódź", "ắ", "Ω", "ἀ", "Я", "Ҁ"] : ["Scan 123 → —", "Łódź", "ắ", "Ω", "Я", "Ҁ"];
      const weights = family === "Inter" ? [300, 400, 500, 600, 700, 800] : [400, 500];
      for (const weight of weights) for (const sample of samples) {
        const faces = await document.fonts.load(`${weight} 16px "${family}"`, sample);
        check(faces.length > 0 && faces.every(face => face.status === "loaded"), `Font missing: ${family} ${weight} ${sample}`);
      }
    }
    const connect = document.querySelector("#btn-connect");
    check(getComputedStyle(connect).fontFamily.includes("Inter"), "Setup does not use Inter");
    const bounds = connect.getBoundingClientRect();
    check(Math.abs((bounds.left + bounds.right) / 2 - innerWidth / 2) < 2, "Connect button is not centered");
    check(bounds.top >= 0 && bounds.bottom <= innerHeight, "Connect button is outside the viewport");
    document.querySelector("#btn-connect").click();
    await waitFor(() => rows().length === 129, "Initial page did not render 128 children");
    const mono = document.querySelector(".font-mono");
    check(mono && getComputedStyle(mono).fontFamily.includes("JetBrains Mono"), "Result does not use JetBrains Mono");
    check(document.documentElement.scrollWidth <= innerWidth, "Results overflow horizontally");
    check(document.body.textContent.includes("128 entries on this page of 271"), "Missing full entry count");
    check(!rows().find(item => item.textContent.includes("file-0")).querySelector("button:disabled"), "File label became an unavailable control");
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
    const previousAcknowledgements = () => (document.body.textContent.match(/Daemon acknowledged shutdown\./g) ?? []).length;
    document.querySelector("#btn-disconnect").click();
    await waitFor(() => document.querySelector("#btn-connect") && !document.querySelector("#btn-connect").disabled, "Acknowledged stop did not release the UI");
    check(previousAcknowledgements() === 1, "Acknowledged stop was not reported accurately");
    for (const outcome of ["unreachable", "invalid", "error-status", "wrong-ack"]) {
      stopOutcome = outcome;
      document.querySelector("#btn-connect").click();
      await waitFor(() => rows().length === 129, "Reconnect after stop failed");
      const warnings = (document.body.textContent.match(/daemon shutdown could not be confirmed:/g) ?? []).length;
      const priorStops = calls.filter(item => item.command === "stop_daemon").length;
      const disconnect = document.querySelector("#btn-disconnect");
      disconnect.click();
      disconnect.click();
      await waitFor(() => disconnect.disabled && document.querySelector("#btn-rescan").disabled, "Stop allowed overlapping actions");
      await waitFor(() => document.querySelector("#btn-connect") && !document.querySelector("#btn-connect").disabled, "Unconfirmed stop did not release the UI");
      check(previousAcknowledgements() === 1, "Unconfirmed stop was reported as acknowledged");
      check((document.body.textContent.match(/daemon shutdown could not be confirmed:/g) ?? []).length === warnings + 1, "Missing unconfirmed-stop warning");
      check(calls.filter(item => item.command === "stop_daemon").length === priorStops + 1, "Duplicate stop request");
      check(rows().length === 0, "Unconfirmed stop retained scan results");
    }
    check(!document.body.textContent.includes("Daemon successfully shut down.") && !document.body.textContent.includes("Daemon was already stopped."), "Unsupported shutdown claim survived");
    const toast = document.querySelector("#toast-container > div:last-child");
    check(toast, "No toast for dismissal integration");
    toast.click();
    await waitFor(() => !toast.isConnected, "App did not remove the dismissed toast");
    check(violations.length === 0, `CSP blocked resources: ${violations.join(", ")}`);
    const fonts = performance.getEntriesByType("resource").filter(entry => entry.name.includes(".woff2"));
    check(fonts.length === 13 && fonts.every(entry => new URL(entry.name).origin === location.origin), "Fonts are missing or fetched off-site");
    report(true);
  })().catch(error => report(false, error.stack ?? String(error)));
})();
