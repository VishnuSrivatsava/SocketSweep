<div align="center">
  <img src="assets/socket_sweep_logo.png" alt="SocketSweep Logo" width="200" />
  <h1>SocketSweep</h1>
  <p><strong>A high-performance Android storage analyzer built to completely bypass the agonizingly slow USB MTP.</strong></p>
  
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" />
  <img src="https://img.shields.io/badge/Tauri-v2-FFC131.svg?logo=tauri&logoColor=white" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/React-19-61DAFB.svg?logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/C%2B%2B-17-00599C.svg?logo=c%2B%2B&logoColor=white" alt="C++17" />
  <img src="https://img.shields.io/badge/Rust-1.70+-000000.svg?logo=rust&logoColor=white" alt="Rust" />
</div>

<br />

By pushing a custom C++ daemon directly to your Android device via ADB and communicating over a local TCP tunnel, SocketSweep achieves near-instantaneous filesystem traversals and deletions. If you have ever waited minutes just to see the contents of your Android's `/sdcard` directory over a USB cable, SocketSweep is the ultimate, blazing-fast alternative.

---

## 📥 Downloads

**[Download SocketSweep v1.0.0 for macOS](https://github.com/VishnuSrivatsava/SocketSweep/releases/tag/v1.0.0)**

- [📱 MacOS (.dmg)](https://github.com/VishnuSrivatsava/SocketSweep/releases/tag/v1.0.0)
- [🪟 Windows (.exe)]() *(Coming Soon)*
- [🐧 Linux (.AppImage)]() *(Coming Soon)*

---

## 🏗 System Architecture

SocketSweep operates across a three-layer stack: **The Glass** (Frontend), **The Bridge** (Rust Backend), and **The Engine** (C++ Android Daemon).

```mermaid
flowchart TB
    subgraph Host["Host Desktop"]
        UI["React + Recharts<br>Interactive Dashboard"]
        Bridge["Rust / Tauri Backend<br>Command Orchestrator"]
        
        UI <--> Bridge
    end

    subgraph Transport["ADB Protocol"]
        Tunnel["ADB Port Forwarding<br>TCP:5050 -> TCP:5050"]
    end

    subgraph Device["Android Device"]
        Daemon["C++17 Daemon<br>Headless Socket Server"]
        Storage[("POSIX Filesystem<br>/sdcard")]
        
        Daemon <--> Storage
    end

    Bridge <--> Tunnel
    Tunnel <--> Daemon
```

## 🔄 Interaction Lifecycle

```mermaid
sequenceDiagram
    participant U as React UI
    participant R as Rust (Tauri)
    participant A as ADB Shell
    participant D as C++ Daemon (Android)
    
    %% Connect Phase
    U->>R: invoke("init_daemon")
    R->>A: pkill daemon (Cleanup)
    R->>A: push daemon /data/local/tmp
    R->>A: appops set MANAGE_EXTERNAL_STORAGE allow
    R->>A: nohup ./daemon &
    R->>A: adb forward tcp:5050 tcp:5050
    R->>D: Ping-Retry Loop (150ms)
    D-->>R: ACK Connection
    R-->>U: Connected!
    
    %% Scan Phase
    U->>R: invoke("run_scan", { path: "/sdcard" })
    R->>D: TCP Send: `SCAN /sdcard\n`
    Note over D: Recursive Fast POSIX Traversal
    D-->>R: Stream Large JSON Tree
    R-->>U: Parse & Render Treemap
    
    %% Delete Phase
    U->>R: invoke("delete_item", { path })
    R->>D: TCP Send: `DELETE /sdcard/... \n`
    Note over D: std::filesystem::remove_all
    D-->>R: {"status":"ok"}
    R-->>U: Update UI / Rescan
```

---

## 🚀 Development Setup & Build

### Prerequisites
1. **Node.js** (v18+)
2. **Rust** (v1.70+ with Cargo)
3. **Android NDK** (v26d or newer)
4. **Android SDK / ADB** installed and added to your system `$PATH`.

### 1. Compile the C++ Engine (Android Daemon)
You must cross-compile the C++ daemon for `aarch64-linux-android` before running the app.
```bash
# Set your NDK path
export NDK=/path/to/your/android-ndk-r26d

# Build the daemon
cd engine
bash ./build.sh
```
*This will generate the stripped `daemon` binary in the `engine/` directory.*

### 2. Install Frontend Dependencies
```bash
# Return to project root
cd ..
npm install
```

### 3. Run the App
```bash
npm run tauri dev
```
*Ensure your Android device is plugged in via USB and **USB Debugging** is enabled.*

---

## 🛠 Troubleshooting

### "0 Files" or Missing Folders on Android 11+
Android 11 introduced Scoped Storage, heavily restricting file access. SocketSweep automatically attempts to grant itself bypass permissions via ADB:
```bash
adb shell appops set com.android.shell MANAGE_EXTERNAL_STORAGE allow
```
If your device still refuses to scan `/sdcard`, ensure that you haven't blocked ADB from managing permissions in your developer options (some OEMs like Xiaomi require "USB Debugging (Security settings)" to be toggled on).

### Daemon Fails to Start
If the daemon is killed immediately or throws `Permission denied`, ensure it is being executed from `/data/local/tmp/`. Modern Android versions prevent executing binaries stored directly on the `/sdcard/`. SocketSweep handles this automatically by pushing to `/data/local/tmp/socketsweep_daemon`.
