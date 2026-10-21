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
  let delayedLargest = true;
  let failLargest = false;
  let failDelete = false;
  let stopOutcome = "acknowledged";
  const readyDevices = [
    { serial: "phone-one", state: "device", model: "Pixel <One>" },
    { serial: "phone-two", state: "device", model: "Tablet Two" },
    { serial: "offline-phone", state: "offline", model: null },
    { serial: "locked-phone", state: "unauthorized", model: null },
  ];
  let listedDevices = readyDevices;
  let discoveryError = false;
  const discoveryDump = "adb devices -l failed (exit 1):\n* daemon not running; starting now at tcp:5037\nADB server didn't ACK\nFull server startup log: /tmp/adb.fixture.log\ncould not install *smartsocket* listener: Address already in use\n<img src=invalid onerror=alert(1)>\n" + "startup diagnostics\n".repeat(2000);
  let activeDevice = null;
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
      if (command === "list_devices") {
        await pause(50);
        if (discoveryError) throw discoveryDump;
        return listedDevices;
      }
      if (command === "check_adb") return "Mock ADB " + "x".repeat(20000);
      if (command === "init_daemon") {
        check(listedDevices.some(device => device.serial === args.serial && device.state === "device"), "Selected device disconnected before startup");
        activeDevice = args.serial;
        return "Mock daemon";
      }
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
      if (command === "get_largest_files") {
        check(Number.isInteger(args.limit) && args.limit > 0 && args.limit <= 100, "Unbounded largest-files query");
        if (failLargest) { failLargest = false; throw "Mock largest-files failure"; }
        const files = [...rootChildren, ...folderChildren].filter(item => item.type === "file")
          .sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
        const response = JSON.stringify({ ...scope(), limit: args.limit, total_files: files.length,
          files: files.slice(0, args.limit).map(item => detail(item.id)) });
        if (delayedLargest) { delayedLargest = false; await pause(300); }
        return response;
      }
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
    output.textContent = JSON.stringify({ fixture: "scan-ui", passed, error, ipc_calls: calls.length, checks: passed ? ["offline fonts under CSP", "bounded collapsed discovery diagnostics", "discovery retry recovery", "setup alignment", "result fonts", "file label semantics", "complete paging", "bounded largest files", "late largest response", "largest query retry", "largest ID-only deletion", "largest read-only guards", "largest folder navigation without rescanning", "late zoom", "Other tile", "stale confirmation", "ID-only deletion", "revision refresh", "partial failure", "read-only", "acknowledged shutdown", "unconfirmed shutdown", "reconnect", "stop action ordering", "toast dismissal integration", "bounded diagnostic integration"] : undefined });
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
    await waitFor(() => !document.querySelector("#btn-refresh-devices").disabled, "Device discovery did not finish");
    const picker = () => document.querySelector("#android-device");
    const selectDevice = serial => {
      picker().value = serial;
      picker().dispatchEvent(new Event("change", { bubbles: true }));
    };
    const refreshDevices = async () => {
      document.querySelector("#btn-refresh-devices").click();
      await waitFor(() => document.querySelector("#btn-refresh-devices").disabled && picker().disabled && document.querySelector("#btn-connect").disabled, "Refresh did not block connection/selection");
      await waitFor(() => !document.querySelector("#btn-refresh-devices").disabled, "Refresh did not finish");
    };
    check(picker().value === "" && connect.disabled, "Multiple ready devices were selected implicitly");
    check(document.querySelector('label[for="android-device"]'), "Picker lacks an accessible label");
    for (const serial of ["offline-phone", "locked-phone"]) {
      check([...picker().options].find(option => option.value === serial).disabled, "Unavailable device is selectable");
    }
    check([...picker().options].some(option => option.textContent.includes("Pixel <One>")) && !document.querySelector("One"), "Model label was treated as markup");
    selectDevice("phone-two");
    await waitFor(() => !connect.disabled, "Selected ready device did not enable Connect");
    listedDevices = readyDevices.filter(device => device.serial !== "phone-two");
    await refreshDevices();
    check(picker().value === "phone-two" && connect.disabled && document.querySelector("#device-status").textContent.includes("disconnected"), "Unplugging switched devices");
    for (const state of ["unauthorized", "offline"]) {
      listedDevices = [readyDevices[0], { ...readyDevices[1], state }];
      await refreshDevices();
      check(picker().value === "phone-two" && connect.disabled, "Unavailable selection fell back to another phone");
    }
    discoveryError = true;
    await refreshDevices();
    const status = document.querySelector("#device-status");
    check(picker().value === "phone-two" && connect.disabled && picker().selectedOptions[0].textContent.includes("Status unavailable"), "Discovery failure did not preserve an unknown, blocked selection");
    check(status.textContent.includes("ADB could not start") && status.textContent.length < 120 && !status.textContent.includes("startup log"), "Raw diagnostics leaked into setup status");
    const diagnostics = document.querySelector("#device-error-details");
    check(diagnostics && !diagnostics.open, "Technical details were expanded by default");
    const closedHeight = diagnostics.getBoundingClientRect().height;
    diagnostics.querySelector("summary").click();
    await waitFor(() => diagnostics.open, "Technical details did not expand");
    const detailText = diagnostics.querySelector("pre");
    check(detailText.textContent.includes("ADB server didn't ACK") && detailText.textContent.includes("… [truncated]") && detailText.textContent.length <= 4096, "Diagnostics were lost or unbounded");
    check(!diagnostics.querySelector("img") && detailText.textContent.includes("<img"), "Diagnostic text became markup");
    check(detailText.getBoundingClientRect().height <= 161 && document.documentElement.scrollWidth <= innerWidth, "Expanded diagnostics broke setup layout");
    diagnostics.querySelector("summary").click();
    check(!diagnostics.open && diagnostics.getBoundingClientRect().height <= closedHeight + 1, "Collapsed diagnostics still occupied the screen");
    discoveryError = false;
    listedDevices = [...readyDevices].reverse();
    await refreshDevices();
    check(picker().value === "phone-two" && !connect.disabled, "Reordered/reconnected devices lost selection");
    // The display is only a snapshot. Native startup must reject a selected
    // device that vanished after this refresh, without choosing the first one.
    listedDevices = [readyDevices[0]];
    connect.click();
    connect.click();
    await waitFor(() => document.querySelector("#btn-connect") && !document.querySelector("#btn-refresh-devices").disabled && document.querySelector("#device-status").textContent.includes("disconnected"), "Stale selected device did not return to setup");
    check(calls.filter(call => call.command === "init_daemon").length === 1 && !calls.some(call => call.command === "run_scan"), "Failed/duplicate connect started a scan or silently chose another device");
    check(picker().value === "phone-two" && document.querySelector("#btn-connect").disabled, "Failed startup replaced selected serial");
    listedDevices = readyDevices;
    await refreshDevices();
    check(getComputedStyle(connect).fontFamily.includes("Inter"), "Setup does not use Inter");
    const bounds = connect.getBoundingClientRect();
    check(Math.abs((bounds.left + bounds.right) / 2 - innerWidth / 2) < 2, `Connect button is not centered: ${bounds.left}..${bounds.right}, viewport ${innerWidth}`);
    check(bounds.top >= 0 && bounds.bottom <= innerHeight, "Connect button is outside the viewport");
    document.querySelector("#btn-connect").click();
    await waitFor(() => rows().length === 129, "Initial page did not render 128 children");
    check(activeDevice === "phone-two" && document.querySelector("#connected-device").textContent.includes("phone-two"), "Results do not identify the selected device");
    const logRows = [...document.querySelectorAll("#terminal-log .log-entry")];
    check(logRows.some(row => row.textContent.includes("[ADB] Found:") && row.textContent.includes("… [truncated]")), "App did not bound oversized diagnostics");
    check(logRows.every(row => row.textContent.length < 4200), "App retained oversized log text");
    const mono = document.querySelector(".font-mono");
    check(mono && getComputedStyle(mono).fontFamily.includes("JetBrains Mono"), "Result does not use JetBrains Mono");
    check(document.documentElement.scrollWidth <= innerWidth, "Results overflow horizontally");
    check(document.body.textContent.includes("128 entries on this page of 271"), "Missing full entry count");
    check(!rows().find(item => item.textContent.includes("file-0")).querySelector("button:disabled"), "File label became an unavailable control");
    const scanCount = calls.filter(item => item.command === "run_scan").length;
    const largestRows = () => [...document.querySelectorAll(".largest-file-row")];
    button("Largest files").click();
    await waitFor(() => document.querySelector("#largest-limit"), "Largest-files controls missing");
    const chooseLimit = count => {
      const select = document.querySelector("#largest-limit");
      select.value = String(count);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    };
    // The first response is delayed; switching limits must win permanently.
    chooseLimit(10);
    await waitFor(() => largestRows().length === 10, "Largest-files limit not applied");
    await pause(350);
    check(largestRows().length === 10, "Late largest-files response replaced the current limit");
    check(largestRows()[0].textContent.includes("/fixture/ file-0 "), "Exact largest-file path missing");
    check(!largestRows().some(row => row.textContent.includes("large-folder")), "Directory ranked as a file");
    check(document.documentElement.scrollWidth <= innerWidth, "Largest files overflow horizontally");
    failLargest = true;
    chooseLimit(50);
    await waitFor(() => button("Retry"), "Largest-files failure not shown");
    button("Retry").click();
    await waitFor(() => largestRows().length === 50, "Largest-files retry failed");
    chooseLimit(100);
    await waitFor(() => largestRows().length === 100, "Maximum largest-files page missing");
    button("Show folder").click();
    await waitFor(() => rows().length === 129, "Show folder did not restore map");
    check(calls.filter(item => item.command === "run_scan").length === scanCount, "Largest-files browsing rescanned the phone");
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
    button("Largest files").click();
    await waitFor(() => largestRows().length === 25, "Largest files missing before delete");
    document.querySelector('[aria-label="Delete  file-0 "]').click();
    await waitFor(() => button("NUKE IT"), "Confirmation missing");
    check(document.body.textContent.includes("/fixture/ file-0 "), "Exact confirmation path missing");
    button("NUKE IT").click();
    await waitFor(() => largestRows().length === 25 && !document.querySelector('[aria-label="Delete  file-0 "]'), "Deleted largest row survived revision refresh");
    button("Storage map").click();
    await waitFor(() => rows().length === 129 && !document.querySelector('[aria-label="Delete  file-0 "]'), "Deleted map row survived revision refresh");
    check(calls.some(item => item.command === "delete_item" && item.args.nodeId === 2 && !("path" in item.args)), "ID-only delete was not invoked");

    button("Largest files").click();
    await waitFor(() => largestRows().length === 25, "Largest files did not refresh after deletion");
    check(!largestRows().some(row => row.textContent.includes("/fixture/ file-0 ")), "Deleted largest file survived revision");
    const nested = largestRows().find(row => row.textContent.includes("/large-folder/"));
    if (nested) nested.querySelector("button").click(); else button("Storage map").click();
    await waitFor(() => rows().length > 0, "Map missing after largest-files navigation");
    if (button("← Back to Root")) { button("← Back to Root").click(); await waitFor(() => rows()[0]?.textContent.includes("fixture"), "Root missing"); }
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
    // Setup refreshes discovery after stopping; it must not replace the stop
    // as the final operation with device-side/session authority.
    check(calls.filter(call => call.command !== "list_devices").at(-1).command === "stop_daemon", "Partial failure did not stop session");

    failDelete = false;
    readOnly = true;
    document.querySelector("#btn-connect").click();
    await waitFor(() => rows().length === 129, "Read-only page missing");
    check(document.body.textContent.includes("Deletion disabled"), "Read-only banner missing");
    check(!document.querySelector('[aria-label^="Delete "]'), "Read-only deletion enabled");
    button("Largest files").click();
    await waitFor(() => largestRows().length === 25, "Read-only largest files missing");
    check([...document.querySelectorAll('.largest-file-row button[aria-label^="Delete "]')].every(item => item.disabled), "Read-only largest deletion enabled");
    button("Storage map").click();
    await waitFor(() => rows().length === 129, "Read-only map missing");
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
    await waitFor(() => !document.querySelector("#btn-refresh-devices").disabled, "Post-stop device refresh did not finish");
    check(picker().value === "phone-two", "Stop forgot the selected phone");
    const previousGeneration = scope().generation;
    readOnly = false;
    stopOutcome = "acknowledged";
    selectDevice("phone-one");
    await pause(20);
    document.querySelector("#btn-connect").click();
    await waitFor(() => rows().length === 129, "Explicit device switch did not scan");
    check(activeDevice === "phone-one" && scope().generation !== previousGeneration && document.querySelector("#connected-device").textContent.includes("phone-one"), "Device switch reused old results/identity");
    check(!button("NUKE IT"), "Device switch retained a destructive confirmation");
    const deleteCallsBeforeSwitch = calls.filter(call => call.command === "delete_item").length;
    document.querySelector('[aria-label="Delete  file-0 "]').click();
    await waitFor(() => button("NUKE IT"), "Cross-device confirmation fixture did not open");
    document.querySelector("#btn-disconnect").click();
    await waitFor(() => document.querySelector("#btn-connect") && !document.querySelector("#btn-connect").disabled, "Stop with a pending confirmation did not finish");
    check(!button("NUKE IT") && picker().value === "phone-one", "Stop retained confirmation or forgot selection");
    selectDevice("phone-two");
    await pause(20);
    document.querySelector("#btn-connect").click();
    await waitFor(() => rows().length === 129, "Switch back to the second phone failed");
    check(activeDevice === "phone-two" && !button("NUKE IT") && calls.filter(call => call.command === "delete_item").length === deleteCallsBeforeSwitch, "An old confirmation crossed device sessions");
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
