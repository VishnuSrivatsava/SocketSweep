// Real built frontend, mocked Tauri IPC. No native app, ADB or device calls.
(() => {
  const calls = [];
  const violations = [];
  document.addEventListener("securitypolicyviolation", event => violations.push(event.blockedURI));
  let generation = 1;
  let revision = 0;
  let unavailable = false;
  let readOnly = false;
  let scanRoot = "/fixture";
  let delayedZoom = true;
  let delayedDetail = true;
  let holdDetail = false;
  let releaseDetail;
  let badDetail = null;
  let delayedLargest = true;
  let failLargest = false;
  let malformedLargest = false;
  let holdSearch = false;
  let resolveSearch;
  let failSearch = false;
  let malformedSearch = false;
  let holdTypes = false;
  let resolveTypes;
  let failTypes = false;
  let invalidTypes = false;
  let emptyScan = false;
  let coverageErrors = 0;
  let coverageSkipped = 0;
  let failDelete = false;
  let failScan = false;
  let holdScan = false;
  let heldScan;
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
  const scanRecords = [];
  let callbacks = 0;
  let rootChildren;
  let folderChildren;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const pressKey = async key => {
    const response = await fetch("/keyboard", { method: "POST", body: JSON.stringify({ key }) });
    check(response.ok, `Trusted keyboard input failed: ${key} (${response.status})`);
  };
  const node = (id, parent_id, name, size, directory = false) => ({
    id, parent_id, name, size, type: directory ? "directory" : "file", counted: true,
    child_count: directory ? 200 : 0, can_delete: id !== 0 && !readOnly,
  });
  const whitespaceName = " file-3  double\t  ";
  const reset = () => {
    folderChildren = Array.from({ length: 200 }, (_, i) => node(i + 1001, 1, `nested-${i}`, 1));
    rootChildren = [node(1, 0, "large-folder", 200, true), ...Array.from({ length: 536 }, (_, i) => node(i + 2, 0, i === 3 ? whitespaceName : ` file-${i} `, 1))];
    if (emptyScan) { rootChildren = []; folderChildren = []; }
    unavailable = false;
    revision = 0;
  };
  reset();
  const scope = () => ({ generation: `fixture-${generation}`, revision });
  const summary = () => ({
    ...scope(), status: "ok", root_path: scanRoot, root: { ...node(0, null, "fixture", rootChildren.reduce((sum, item) => sum + item.size, 0), true), child_count: rootChildren.length },
    total_files: rootChildren.filter(item => item.type === "file").length + folderChildren.length, total_dirs: 1 + rootChildren.filter(item => item.type === "directory").length,
    total_size: rootChildren.reduce((sum, item) => sum + item.size, 0), errors: coverageErrors, skipped: coverageSkipped, scan_time_ms: 1, read_only: readOnly,
  });
  const detail = id => {
    const target = id === 0 ? summary().root : [...rootChildren, ...folderChildren].find(item => item.id === id);
    check(target, "Unknown mock node");
    return { ...scope(), node: target, path: `${scanRoot}/${target.parent_id === 1 ? "large-folder/" : ""}${target.name}` };
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
    return { ...scope(), node: directory, path: args.nodeId === 0 ? scanRoot : detail(args.nodeId).path,
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
        check(listedDevices.some(device => device.serial === args.serial && device.state === "device"), "Selected device disconnected before startup\nfixture startup details <stderr>");
        activeDevice = args.serial;
        return "Mock daemon";
      }
      if (command === "run_scan") {
        if (failScan) { failScan = false; throw "Fixture rescan failure"; }
        if (holdScan) {
          holdScan = false;
          return new Promise((_, reject) => { heldScan = { scanId: args.scanId, reject }; });
        }
        generation++;
        reset();
        const stats = summary();
        scanRecords.push({
          generation: scope().generation,
          device: activeDevice,
          readOnly, errors: stats.errors, skipped: stats.skipped, root: stats.root_path,
          totals: { total_files: stats.total_files, total_dirs: stats.total_dirs, total_size: stats.total_size },
          at: Date.now(),
        });
        return JSON.stringify(stats);
      }
      if (command === "cancel_scan") {
        check(heldScan && args.scanId === heldScan.scanId, "Cancellation targeted the wrong scan");
        heldScan.reject("Scan cancelled");
        heldScan = undefined;
        return;
      }
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
      if (command === "get_file_types") {
        if (failTypes) { failTypes = false; throw "Fixture file-type query failure"; }
        const stats = summary();
        const data = { ...scope(), total_files: stats.total_files, total_size: stats.total_size,
          categories: ["images", "videos", "audio", "documents", "archives", "android_packages", "no_extension", "other"].map(kind => ({ kind, files: kind === "no_extension" ? stats.total_files : 0, size: kind === "no_extension" ? stats.total_size : 0 })) };
        if (invalidTypes) { invalidTypes = false; data.categories[0].files = 1; }
        const raw = JSON.stringify(data);
        if (holdTypes) { holdTypes = false; return new Promise(resolve => { resolveTypes = () => resolve(raw); }); }
        return raw;
      }
      if (command === "get_largest_files") {
        check(Number.isInteger(args.limit) && args.limit > 0 && args.limit <= 100, "Unbounded largest-files query");
        if (failLargest) { failLargest = false; throw "Mock largest-files failure"; }
        if (malformedLargest) {
          malformedLargest = false;
          return JSON.stringify({ ...scope(), limit: args.limit, total_files: summary().total_files, files: null });
        }
        const files = [...rootChildren, ...folderChildren].filter(item => item.type === "file")
          .sort((a, b) => b.size - a.size || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id));
        const response = JSON.stringify({ ...scope(), limit: args.limit, total_files: files.length,
          files: files.slice(0, args.limit).map(item => detail(item.id)) });
        if (delayedLargest) { delayedLargest = false; await pause(300); }
        return response;
      }
      if (command === "get_search_results") {
        check(typeof args.query === "string" && args.query !== "" && args.query.length <= 255, "Unbounded search query");
        check(Number.isInteger(args.skip) && args.skip >= 0, "Invalid search skip");
        if (failSearch) { failSearch = false; throw "Fixture search failure"; }
        if (malformedSearch) {
          malformedSearch = false;
          return JSON.stringify({ ...scope(), query: args.query, skip: args.skip, has_more: false, results: null });
        }
        const matches = [...rootChildren, ...folderChildren].filter(item => item.name.toLowerCase().includes(args.query.toLowerCase()));
        // Simulate a page shortened by the backend's serialized-byte budget.
        const limit = args.query === "nested" ? 37 : 100;
        const response = JSON.stringify({ ...scope(), query: args.query, skip: args.skip,
          has_more: matches.length > args.skip + limit,
          results: matches.slice(args.skip, args.skip + limit).map(item => detail(item.id)) });
        if (holdSearch) { holdSearch = false; return new Promise(resolve => { resolveSearch = () => resolve(response); }); }
        return response;
      }
      if (command === "get_scan_comparison") {
        // Same shape as the Rust query: the delta compares the live totals
        // with the previous scan of the same device, so deletions count.
        const current = scanRecords.find(record => record.generation === scope().generation);
        check(current, "Comparison requested for an unknown mock scan");
        check(current.errors === 0, "Scans with access errors are not recorded as history baselines");
        const previous = scanRecords.slice(0, scanRecords.indexOf(current)).reverse()
          .find(record => record.errors === 0 && record.device === current.device
            && record.readOnly === current.readOnly && record.root === current.root && record.skipped === current.skipped);
        if (!previous) return JSON.stringify({ ...scope(), first: true, previous: null, delta: null });
        const stats = summary();
        return JSON.stringify({ ...scope(), first: false,
          previous: { recorded_at: Math.floor(previous.at / 1000), ...previous.totals },
          delta: {
            files: stats.total_files - previous.totals.total_files,
            dirs: stats.total_dirs - previous.totals.total_dirs,
            size: stats.total_size - previous.totals.total_size,
          } });
      }
      if (command === "get_scan_view") {
        const response = JSON.stringify(view(args));
        if (args.nodeId === 1 && delayedZoom) { delayedZoom = false; await pause(300); }
        return response;
      }
      if (command === "get_scan_node") {
        if (badDetail) {
          const path = badDetail === "object" ? {} : "/outside/file-0";
          badDetail = null;
          return JSON.stringify({ ...detail(args.nodeId), path });
        }
        const response = JSON.stringify(detail(args.nodeId));
        if (holdDetail) { holdDetail = false; return new Promise(resolve => { releaseDetail = () => resolve(response); }); }
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
  let widePaging;
  const report = (passed, error) => {
    const output = document.createElement("pre");
    output.id = "scan-test-report";
    output.textContent = JSON.stringify({ fixture: "scan-ui", passed, error, ipc_calls: calls.length, wide_paging: widePaging, checks: passed ? ["offline fonts under CSP", "bounded collapsed discovery diagnostics", "discovery retry recovery", "setup alignment", "result fonts", "file label semantics", "usable file workspace", "collapsible diagnostics", "complete paging", "first-scan comparison", "unchanged comparison after rescan", "deletion delta comparison", "cross-device comparison isolation", "bounded file-type totals", "file-type retry and malformed response", "file-type generation and deletion revision", "file-type coverage and empty scan", "bounded largest files", "late largest response", "largest query retry", "malformed largest response recovery", "largest ID-only deletion", "largest read-only guards", "largest folder navigation without rescanning", "bounded search results", "late search response", "search retry and malformed response", "search ID-only deletion", "read-only search deletion disabled", "late zoom", "Other tile", "stale confirmation", "exact confirmation whitespace", "reachable long-path confirmation", "native modal keyboard focus and cancellation", "ID-only deletion", "revision refresh", "partial failure", "read-only", "acknowledged shutdown", "unconfirmed shutdown", "reconnect", "stop action ordering", "duplicate rescan guard", "rescan failure recovery", "rescan cancellation recovery", "toast dismissal integration", "bounded diagnostic integration"] : undefined });
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
    listedDevices = [null];
    await refreshDevices();
    check(picker().value === "phone-two" && connect.disabled && status.textContent.includes("Couldn't check connected devices"),
      "Malformed device discovery did not preserve the selection and disable Connect");
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
    check(!document.querySelector("#toast-container").textContent.includes("fixture startup details"), "Startup diagnostics filled the toast");
    check(document.querySelector("#terminal-log").textContent.includes("fixture startup details <stderr>") && !document.querySelector("#terminal-log stderr"), "Startup diagnostics were lost or treated as markup");
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
    await waitFor(() => document.querySelector("#scan-history")?.textContent.includes("No previous comparable scan"), "First-scan comparison missing");
    const logRows = [...document.querySelectorAll("#terminal-log .log-entry")];
    check(logRows.some(row => row.textContent.includes("[ADB] Found:") && row.textContent.includes("… [truncated]")), "App did not bound oversized diagnostics");
    check(logRows.every(row => row.textContent.length < 4200), "App retained oversized log text");
    const mono = document.querySelector(".font-mono");
    check(mono && getComputedStyle(mono).fontFamily.includes("JetBrains Mono"), "Result does not use JetBrains Mono");
    check(document.documentElement.scrollWidth <= innerWidth, "Results overflow horizontally");
    check(document.body.textContent.includes("128 entries on this page of 537"), "Missing full entry count");
    check(!rows().find(item => item.textContent.includes("file-0")).querySelector("button:disabled"), "File label became an unavailable control");
    const deletesBeforeWhitespace = calls.filter(call => call.command === "delete_item").length;
    const whitespaceDelete = [...document.querySelectorAll('button[aria-label^="Delete "]')]
      .find(item => item.getAttribute("aria-label") === `Delete ${whitespaceName}`);
    check(whitespaceDelete, "Whitespace filename missing from the initial page");
    const detailDelayBeforeWhitespace = delayedDetail;
    whitespaceDelete.click();
    await waitFor(() => button("NUKE IT"), "Whitespace confirmation missing");
    const exactPath = `/fixture/${whitespaceName}`;
    const confirmationPath = [...document.querySelectorAll("p")].find(item => item.textContent === exactPath);
    check(confirmationPath?.innerText === exactPath, "Confirmation collapses filename whitespace");
    for (let index = 0; index < exactPath.length; index++) {
      if (exactPath[index] !== " " && exactPath[index] !== "\t") continue;
      const range = document.createRange();
      range.setStart(confirmationPath.firstChild, index);
      range.setEnd(confirmationPath.firstChild, index + 1);
      check(range.getBoundingClientRect().width > 0, `Confirmation whitespace at ${index} has no rendered width`);
    }
    button("Cancel").click();
    await waitFor(() => !button("NUKE IT"), "Whitespace confirmation did not cancel");
    check(calls.filter(call => call.command === "delete_item").length === deletesBeforeWhitespace, "Cancelled whitespace confirmation issued a delete");
    delayedDetail = detailDelayBeforeWhitespace;
    const fileViewport = document.querySelector('[aria-label="Files and folders"]');
    const fileBounds = fileViewport.getBoundingClientRect();
    check(fileBounds.height >= innerHeight * 0.55, `File browser too short: ${fileBounds.height}px of ${innerHeight}px`);
    check(fileViewport.scrollHeight > fileViewport.clientHeight, "File browser cannot scroll its entries");
    const logDisclosure = document.querySelector("#terminal-log");
    check(logDisclosure.tagName === "DETAILS" && !logDisclosure.open, "Diagnostics did not start collapsed");
    logDisclosure.querySelector("summary").click();
    await waitFor(() => logDisclosure.open, "Diagnostics did not open");
    check(logDisclosure.getBoundingClientRect().height > 100 && logRows[0].getBoundingClientRect().height > 0, "Expanded diagnostics are not readable");
    check(fileViewport.clientHeight >= innerHeight * 0.3, "Expanded diagnostics made files unusable");
    logDisclosure.querySelector("summary").click();
    await waitFor(() => !logDisclosure.open, "Diagnostics did not close");
    check(Math.abs(fileViewport.getBoundingClientRect().height - fileBounds.height) < 2, "Closing diagnostics did not restore browsing space");
    const scrollBefore = fileViewport.scrollTop;
    fileViewport.scrollTop = 200;
    check(fileViewport.scrollTop > scrollBefore, "File list does not scroll independently");
    fileViewport.scrollTop = 0;
    const scanCount = calls.filter(item => item.command === "run_scan").length;
    const typesPanel = () => document.querySelector('section[aria-label="File types"]');
    const typesReady = () => typesPanel()?.querySelector('table[aria-busy="false"]') && !typesPanel().querySelector('[role="alert"]');
    const checkTypes = count => {
      const panel = typesPanel();
      check(panel.querySelectorAll(".file-type-row").length === 8, "File-type rows are unbounded");
      check(panel.querySelector('[data-kind="no_extension"]').cells[1].textContent === String(count), "File-type count did not match scan");
      check(panel.querySelector("tfoot").textContent.includes(String(count)), "File-type total missing");
      check(document.documentElement.scrollWidth <= innerWidth, "File-type view overflows horizontally");
      check(!panel.querySelector('button[aria-label^="Delete "]'), "File type became a deletion target");
    };
    holdTypes = true;
    button("File types").click();
    await waitFor(() => resolveTypes && typesPanel()?.querySelector('table[aria-busy="true"]'), "Pending file-type query missing");
    const oldTypes = resolveTypes;
    const rescan = document.querySelector("#btn-rescan");
    rescan.click();
    rescan.click();
    await waitFor(() => rows().length === 129, "Rescan during file-type query failed");
    check(calls.filter(item => item.command === "run_scan").length === scanCount + 1, "Duplicate rescan queued a second scan");
    button("File types").click();
    await waitFor(typesReady, "File-type summary missing after rescan");
    oldTypes();
    await pause(30);
    checkTypes(736);
    check(!typesPanel().querySelector('[role="alert"]'), "Late file-type response crossed generations");
    const typeScanCount = calls.filter(item => item.command === "run_scan").length;
    for (const invalid of [false, true]) {
      button("Storage map").click();
      await waitFor(() => rows().length === 129, "Map missing before file-type retry");
      if (invalid) invalidTypes = true; else failTypes = true;
      button("File types").click();
      await waitFor(() => typesPanel()?.querySelector('[role="alert"]'), "Invalid file-type summary did not fail");
      check(!typesPanel().textContent.includes("736 scanned files"), "File-type failure retained old totals");
      button("Retry").click();
      await waitFor(typesReady, "File-type retry failed");
      checkTypes(736);
    }
    check(calls.filter(item => item.command === "run_scan").length === typeScanCount, "File-type browsing rescanned the phone");
    button("Storage map").click();
    await waitFor(() => rows().length === 129, "Map missing after file types");
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
    malformedLargest = true;
    chooseLimit(25);
    await waitFor(() => button("Retry") || !document.querySelector("#btn-rescan"), "Malformed largest-files response did not offer retry");
    check(button("Retry") && largestRows().length === 0 && document.querySelector("#btn-rescan"), "Malformed largest-files response retained rows or crashed results");
    button("Retry").click();
    await waitFor(() => largestRows().length === 25, "Malformed largest-files response did not recover");
    button("Show folder").click();
    await waitFor(() => rows().length === 129, "Show folder did not restore map");
    check(calls.filter(item => item.command === "run_scan").length === scanCount + 1, "Largest-files browsing rescanned the phone");
    const visibleNames = () => rows().slice(1).map(row =>
      row.querySelector('[aria-label^="Delete "]')?.getAttribute("aria-label").slice("Delete ".length));
    const expectedNames = rootChildren.map(child => child.name);
    const expectedPages = [];
    for (let offset = 0; offset < expectedNames.length; offset += 128) {
      expectedPages.push(expectedNames.slice(offset, offset + 128));
    }
    const pageMatches = expected => JSON.stringify(visibleNames()) === JSON.stringify(expected);
    check(pageMatches(expectedPages[0]), "First page changed entry order");
    const focusTarget = rows()[1].querySelector('[aria-label^="Delete "]');
    focusTarget.focus();
    const pagingViewport = focusTarget.closest("section");
    pagingViewport.scrollTop = pagingViewport.scrollHeight;
    check(pagingViewport.scrollTop > 0, "Wide page could not scroll");
    check(document.activeElement === focusTarget, "Scrolling dropped keyboard focus");
    const pageTimes = [];
    const visitPage = async (direction, expected) => {
      const started = performance.now();
      button(direction).click();
      await waitFor(() => pageMatches(expected), `${direction} page omitted, duplicated or reordered entries`);
      pageTimes.push(performance.now() - started);
      check(rows().length <= 129, "Page exceeded the rendered-row bound");
    };
    for (const page of expectedPages.slice(1)) await visitPage("Next", page);
    check(!button("Next"), "Final page had an unexpected continuation");
    for (const page of expectedPages.slice(0, -1).reverse()) await visitPage("Previous", page);
    check(!button("Previous"), "First page had an unexpected previous cursor");
    widePaging = { entries: expectedNames.length, max_rows: 129, transition_ms: pageTimes.map(ms => Math.round(ms)) };

    // Search: bounded pages, a superseded held response, retry, malformed
    // recovery, and ID-only deletion. No rescan is ever allowed here.
    const searchRows = () => [...document.querySelectorAll(".search-result-row")];
    const searchFor = text => {
      const input = document.querySelector("#search-input");
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      set.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.querySelector("#search-submit").click();
    };
    const searchNext = () => [...document.querySelectorAll("button")].find(item => item.textContent.trim() === "Next" && !item.disabled);
    button("Search").click();
    await waitFor(() => document.querySelector("#search-input"), "Search controls missing");
    // The first response is held; an empty superseding query must win and
    // the held response must never replace it.
    holdSearch = true;
    searchFor("file");
    await waitFor(() => document.querySelector("#search-input").value === "file", "Search query not submitted");
    searchFor("zzz-no-match");
    await waitFor(() => document.body.textContent.includes("No matching names"), "Superseding search state missing");
    resolveSearch();
    await pause(60);
    check(searchRows().length === 0 && document.body.textContent.includes("No matching names"), "Held search response replaced the current results");
    searchFor("file");
    await waitFor(() => searchRows().length === 100, "Bounded search page missing");
    check(searchNext(), "Search continuation missing");
    searchNext().click();
    await waitFor(() => searchRows().length > 0, "Second search page missing");
    searchFor("nested");
    await waitFor(() => searchRows().length === 37, "Byte-bounded search page missing");
    const nestedCount = searchRows().length;
    const firstNestedNames = searchRows().map(row => row.textContent);
    searchNext().click();
    await waitFor(() => searchRows()[0]?.textContent.includes("nested-37"), "Short-page continuation skipped matches");
    check(calls.filter(call => call.command === "get_search_results").at(-1).args.skip === 37, "Short-page continuation used a fixed offset");
    button("Previous").click();
    await waitFor(() => searchRows()[0]?.textContent.includes("nested-0"), "Short-page Previous failed");
    check(JSON.stringify(searchRows().map(row => row.textContent)) === JSON.stringify(firstNestedNames), "Previous changed short-page boundaries");
    searchFor("zzz-no-match");
    await waitFor(() => document.body.textContent.includes("No matching names"), "Empty search state missing");
    failSearch = true;
    searchFor("file");
    await waitFor(() => button("Retry"), "Search failure not shown");
    button("Retry").click();
    await waitFor(() => searchRows().length === 100, "Search retry failed");
    malformedSearch = true;
    searchFor("nested");
    await waitFor(() => button("Retry"), "Malformed search response did not offer retry");
    check(searchRows().length === 0, "Malformed search response retained rows");
    button("Retry").click();
    await waitFor(() => searchRows().length === nestedCount, "Malformed search response did not recover");
    searchFor("zzz-no-match");
    await waitFor(() => document.body.textContent.includes("No matching names"), "Pre-delete empty state missing");
    searchFor("file");
    await waitFor(() => searchRows().length === 100, "Search results missing before delete");
    searchNext().click();
    await waitFor(() => searchRows()[0]?.textContent.includes(" file-100 "), "Second page missing before delete");
    // Keep " file-0 "/" file-1 " for the later confirmation and
    // partial-failure phases; delete another root file so the search row
    // disappears on the revision refresh.
    const target = searchRows().find(row => !row.textContent.includes("/large-folder/")
      && !row.textContent.includes(" file-0 ") && !row.textContent.includes(" file-1 "));
    const targetLabel = target.querySelector('[aria-label^="Delete "]').getAttribute("aria-label");
    const deletesBeforeSearch = calls.filter(call => call.command === "delete_item").length;
    const trigger = target.querySelector('[aria-label^="Delete "]');
    trigger.focus();
    check(document.activeElement === trigger, "Search delete trigger cannot receive focus");
    holdDetail = true;
    const pendingConfirmation = pressKey("Enter");
    await waitFor(() => releaseDetail, "Delete detail request did not start");
    const rescanTrigger = document.querySelector("#btn-rescan");
    rescanTrigger.focus();
    check(document.activeElement === rescanTrigger, "Focus did not move during the detail request");
    releaseDetail();
    await pendingConfirmation;
    await waitFor(() => button("NUKE IT"), "Keyboard did not open search confirmation");
    const dialog = document.querySelector("dialog");
    check(dialog?.matches(":modal"), "Confirmation is not a native modal dialog");
    check(document.getElementById(dialog.getAttribute("aria-labelledby"))?.textContent === "Delete Item?", "Dialog has no accessible name");
    check(document.activeElement === button("Cancel"), "Confirmation did not focus the safe Cancel action");
    document.querySelector("#btn-rescan").focus();
    check(dialog.contains(document.activeElement), "Background stole modal focus");
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let index = 0; index < 4; index++) {
        const previousFocus = document.activeElement;
        await pressKey(key);
        check(dialog.contains(document.activeElement) && document.activeElement !== previousFocus,
          `${key} did not move focus within the confirmation`);
      }
    }
    await pressKey("Escape");
    await waitFor(() => !document.querySelector("dialog") && document.activeElement === trigger, "Escape did not cancel and restore trigger focus");
    check(calls.filter(call => call.command === "delete_item").length === deletesBeforeSearch, "Escape issued a delete");
    await pressKey("Enter");
    await waitFor(() => document.activeElement === button("Cancel"), "Reopened confirmation lost safe focus");
    await pressKey("Enter");
    await waitFor(() => !document.querySelector("dialog") && document.activeElement === trigger, "Cancel did not restore trigger focus");
    check(calls.filter(call => call.command === "delete_item").length === deletesBeforeSearch, "Default Enter issued a delete");
    trigger.click();
    await waitFor(() => button("NUKE IT"), "Search confirmation missing");
    button("NUKE IT").click();
    await waitFor(() => !document.querySelector(`[aria-label="${targetLabel}"]`), "Deleted search row survived revision refresh");
    await waitFor(() => searchRows()[0]?.textContent.includes(" file-0 "), "Deletion did not restart search pagination");
    check(calls.filter(call => call.command === "get_search_results").at(-1).args.skip === 0, "Revision refresh retained the old offset");
    check(!button("Previous"), "Previous remained enabled after revision reset");
    check(calls.filter(call => call.command === "delete_item").length === deletesBeforeSearch + 1, "Search deletion count wrong");
    check(calls.filter(item => item.command === "run_scan").length === scanCount + 1, "Search browsing rescanned the phone");
    button("Storage map").click();
    await waitFor(() => rows().length === 129, "Map missing after search");

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

    const mapFolder = document.querySelector('svg [role="button"][aria-label^="large-folder"]');
    check(mapFolder, "Storage map folder is not keyboard accessible");
    mapFolder.focus();
    check(document.activeElement === mapFolder, "Storage map folder did not receive focus");
    await pressKey("Enter");
    await waitFor(() => button("← Back to Root") && rows().length === 129, "Keyboard map zoom failed");
    button("← Back to Root").click();
    await waitFor(() => !button("← Back to Root") && rows().some(row => row.textContent.includes("large-folder")), "Map zoom did not return to root");

    for (const invalidPath of ["object", "outside"]) {
      badDetail = invalidPath;
      const toastsBeforeBadDetail = new Set(document.querySelectorAll("#toast-container > div"));
      const deletesBeforeBadDetail = calls.filter(call => call.command === "delete_item").length;
      document.querySelector('[aria-label="Delete  file-0 "]').click();
      await waitFor(() => !document.querySelector("#btn-rescan") || button("NUKE IT") || [...document.querySelectorAll('#toast-container [role="alert"]')].some(toast =>
        !toastsBeforeBadDetail.has(toast) && toast.textContent.includes("Scan node response does not match this scan")), "Malformed confirmation was not reported");
      check(document.querySelector("#btn-rescan") && !button("NUKE IT"), "Malformed confirmation crashed results or opened a delete dialog");
      check(calls.filter(call => call.command === "delete_item").length === deletesBeforeBadDetail, "Malformed confirmation issued a delete");
    }

    document.querySelector('[aria-label="Delete  file-0 "]').click();
    document.querySelector("#btn-rescan").click();
    await waitFor(() => rows().length === 129, "Rescan did not reload");
    await waitFor(() => document.querySelector("#scan-history")?.textContent.includes("No change since"), "Unchanged comparison missing after rescan");
    await pause(350);
    check(!button("NUKE IT"), "Old confirmation survived rescan");
    button("Largest files").click();
    await waitFor(() => largestRows().length === 25, "Largest files missing before delete");
    document.querySelector('[aria-label="Delete  file-0 "]').click();
    await waitFor(() => button("NUKE IT"), "Confirmation missing");
    check(document.body.textContent.includes("/fixture/ file-0 "), "Exact confirmation path missing");
    button("NUKE IT").click();
    await waitFor(() => largestRows().length === 25 && !document.querySelector('[aria-label="Delete  file-0 "]'), "Deleted largest row survived revision refresh");
    const historyLine = () => document.querySelector("#scan-history")?.textContent ?? "";
    await waitFor(() => historyLine().includes("Since the previous scan"), "Deletion delta comparison missing");
    check(historyLine().includes("-1 files"), "Deletion did not change the comparison delta");
    button("Storage map").click();
    await waitFor(() => rows().length === 129 && !document.querySelector('[aria-label="Delete  file-0 "]'), "Deleted map row survived revision refresh");
    check(calls.some(item => item.command === "delete_item" && item.args.nodeId === 2 && !("path" in item.args)), "ID-only delete was not invoked");

    button("Largest files").click();
    await waitFor(() => largestRows().length === 25, "Largest files did not refresh after deletion");
    check(!largestRows().some(row => row.textContent.includes("/fixture/ file-0 ")), "Deleted largest file survived revision");
    button("File types").click();
    await waitFor(typesReady, "File types did not refresh after deletion");
    checkTypes(735);
    button("Largest files").click();
    await waitFor(() => largestRows().length === 25, "Largest files missing after type refresh");
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
    coverageErrors = 2;
    coverageSkipped = 3;
    document.querySelector("#btn-connect").click();
    await waitFor(() => rows().length === 129, "Read-only page missing");
    check(document.body.textContent.includes("Deletion disabled"), "Read-only banner missing");
    await waitFor(() => document.querySelector("#scan-history")?.textContent.includes("comparison unavailable"), "Partial scan claimed a history comparison");
    check(!document.querySelector('[aria-label^="Delete "]'), "Read-only deletion enabled");
    button("Largest files").click();
    await waitFor(() => largestRows().length === 25, "Read-only largest files missing");
    check([...document.querySelectorAll('.largest-file-row button[aria-label^="Delete "]')].every(item => item.disabled), "Read-only largest deletion enabled");
    button("Search").click();
    await waitFor(() => document.querySelector("#search-input"), "Read-only search controls missing");
    searchFor("file");
    await waitFor(() => searchRows().length > 0, "Read-only search results missing");
    check(searchRows().length > 0 && [...document.querySelectorAll('.search-result-row button[aria-label^="Delete "]')].every(item => item.disabled), "Read-only search deletion enabled");
    button("Storage map").click();
    await waitFor(() => rows().length === 129, "Read-only map missing after search");
    button("File types").click();
    await waitFor(typesReady, "Read-only file types missing");
    checkTypes(736);
    check(typesPanel().textContent.includes("2 access errors") && typesPanel().textContent.includes("3 excluded or duplicate entries") && typesPanel().textContent.includes("/fixture"), "File-type coverage context missing");
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
    coverageErrors = 0;
    coverageSkipped = 0;
    stopOutcome = "acknowledged";
    selectDevice("phone-one");
    await pause(20);
    document.querySelector("#btn-connect").click();
    await waitFor(() => rows().length === 129, "Explicit device switch did not scan");
    check(activeDevice === "phone-one" && scope().generation !== previousGeneration && document.querySelector("#connected-device").textContent.includes("phone-one"), "Device switch reused old results/identity");
    await waitFor(() => document.querySelector("#scan-history")?.textContent.includes("No previous comparable scan"), "Cross-device comparison reused another device's baseline");
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
    emptyScan = true;
    document.querySelector("#btn-rescan").click();
    await waitFor(() => rows().length === 1, "Empty scan missing");
    button("File types").click();
    await waitFor(typesReady, "Empty file-type summary missing");
    checkTypes(0);
    check(typesPanel().textContent.includes("No counted files") && !typesPanel().textContent.includes("NaN") && !typesPanel().textContent.includes("Infinity"), "Empty file-type view is misleading");
    // Exercise the actual App callbacks: duplicate/sibling actions must not
    // queue behind a rescan, and its guard must release on every outcome.
    for (const outcome of ["failure", "cancel"]) {
      const scansBefore = calls.filter(call => call.command === "run_scan").length;
      const stopsBefore = calls.filter(call => call.command === "stop_daemon").length;
      const rescanButton = document.querySelector("#btn-rescan");
      const stopButton = document.querySelector("#btn-disconnect");
      if (outcome === "failure") failScan = true; else holdScan = true;
      rescanButton.click();
      rescanButton.click();
      stopButton.click();
      check(calls.filter(call => call.command === "run_scan").length === scansBefore + 1, "Duplicate failed/pending rescan queued another scan");
      check(calls.filter(call => call.command === "stop_daemon").length === stopsBefore, "Disconnect competed with a pending rescan");
      if (outcome === "cancel") {
        await waitFor(() => heldScan && button("Cancel scan"), "Pending rescan cannot be cancelled");
        const pendingId = heldScan.scanId;
        button("Cancel scan").click();
        check(calls.some(call => call.command === "cancel_scan" && call.args.scanId === pendingId), "Rescan cancellation was not sent");
      }
      await waitFor(() => document.querySelector("#btn-connect") && !document.querySelector("#btn-connect").disabled, "Failed/cancelled rescan did not return to ready setup");
      check(rows().length === 0, "Failed/cancelled rescan retained old results");
      check(calls.filter(call => call.command === "stop_daemon").length === stopsBefore + 1, "Rescan failure did not clean up exactly once");
      document.querySelector("#btn-connect").click();
      await waitFor(() => rows().length === 1, "Rescan guard remained held after failure/cancellation");
      check(calls.filter(call => call.command === "run_scan").length === scansBefore + 2, "Recovery did not start exactly one fresh scan");
    }
    // A deep scan root keeps the catalog consistent without inventing parent IDs.
    emptyScan = false;
    scanRoot = "/" + Array.from({ length: 29 }, (_, index) => `directory-${index}-${"d".repeat(60)}`).join("/") + "/fixture";
    document.querySelector("#btn-rescan").click();
    await waitFor(() => rows().length === 129, "Deep-root scan did not render");
    const deletesBeforeLongPath = calls.filter(call => call.command === "delete_item").length;
    document.querySelector('[aria-label="Delete  file-0 "]').click();
    await waitFor(() => button("NUKE IT"), "Long-path confirmation missing");
    const fullPath = `${scanRoot}/ file-0 `;
    const longPath = [...document.querySelectorAll("p")].find(item => item.textContent === fullPath);
    check(longPath, "Confirmation truncated or changed the long path");
    for (const action of [button("Cancel"), button("NUKE IT")]) {
      const bounds = action.getBoundingClientRect();
      check(bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.left >= 0 && bounds.right <= innerWidth,
        `Long-path action outside viewport: ${bounds.top}..${bounds.bottom} of ${innerHeight}`);
      const hit = document.elementFromPoint((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2);
      check(action === hit || action.contains(hit), "Long-path action is obscured");
    }
    check(longPath.scrollHeight > longPath.clientHeight, "Long path has no scrollable area");
    check(longPath.tabIndex === 0, "Long path cannot be reached by keyboard");
    longPath.focus();
    check(document.activeElement === longPath, "Long path cannot receive keyboard focus");
    longPath.scrollTop = longPath.scrollHeight;
    check(longPath.scrollTop > 0, "Long path cannot be scrolled");
    const lastCharacter = document.createRange();
    lastCharacter.setStart(longPath.firstChild, fullPath.length - 1);
    lastCharacter.setEnd(longPath.firstChild, fullPath.length);
    const lastBounds = lastCharacter.getBoundingClientRect();
    const pathBounds = longPath.getBoundingClientRect();
    check(lastBounds.top >= pathBounds.top && lastBounds.bottom <= pathBounds.bottom, "End of long path is unreachable");
    button("Cancel").click();
    await waitFor(() => !button("NUKE IT"), "Long-path confirmation did not cancel");
    check(calls.filter(call => call.command === "delete_item").length === deletesBeforeLongPath, "Long-path cancellation issued a delete");
    check(violations.length === 0, `CSP blocked resources: ${violations.join(", ")}`);
    const fonts = performance.getEntriesByType("resource").filter(entry => entry.name.includes(".woff2"));
    check(fonts.length === 13 && fonts.every(entry => new URL(entry.name).origin === location.origin), "Fonts are missing or fetched off-site");
    report(true);
  })().catch(error => report(false, error.stack ?? String(error)));
})();
