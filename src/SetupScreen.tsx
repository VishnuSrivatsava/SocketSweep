import type { useDevices } from "./useDevices";
import { deviceSelectionHint, deviceStateLabel } from "./devices";

// ── Icons (inline SVG) ──────────────────────────────────────────────────────

function IconUsb() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-8m0 0V6m0 8l4-2v-2m-4 4l-4-2v-2"/>
      <circle cx="12" cy="4" r="2"/>
      <circle cx="8" cy="10" r="1"/>
      <rect x="15" y="9" width="2" height="2" rx="0.5"/>
    </svg>
  );
}

function Spinner({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" opacity="0.2"/>
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

// ── Setup Screen ────────────────────────────────────────────────────────────

export function SetupScreen({ onConnect, loading, rootMode, onRootModeChange, rootPath, onRootPathChange, deviceSelection }: {
  onConnect: () => void;
  loading: boolean;
  rootMode: boolean;
  onRootModeChange: (enabled: boolean) => void;
  rootPath: string;
  onRootPathChange: (path: string) => void;
  deviceSelection: ReturnType<typeof useDevices>;
}) {
  const { devices, serial, select, loading: refreshing, error, refresh, ready } = deviceSelection;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-8" style={{ scrollbarGutter: "stable both-edges" }}>
      <div className="min-h-full flex flex-col items-center justify-center gap-8 animate-fade-in-up">
        {/* Hero */}
        <div className="flex flex-col items-center gap-6">
          <div className={`
            w-24 h-24 rounded-2xl bg-gradient-to-br from-accent-500/20 to-accent-700/10
            border border-accent-500/20 flex items-center justify-center
            ${loading ? "animate-pulse-glow" : ""}
          `}>
            <span className="text-accent-400">
              <IconUsb />
            </span>
          </div>

          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight bg-gradient-to-r from-zinc-100 to-zinc-400 bg-clip-text text-transparent">
              SocketSweep
            </h1>
            <p className="mx-auto mt-2 text-sm text-zinc-500 max-w-xs leading-relaxed">
              High-performance Android storage analyzer.
              <br />
              <span className="text-zinc-600">Bypasses MTP — direct POSIX scanning.</span>
            </p>
          </div>
        </div>

        <div className="w-full max-w-xs flex flex-col items-center gap-5 text-sm">
          <div className="w-full space-y-2">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="android-device" className="text-xs text-zinc-400">Android device</label>
              <button type="button" id="btn-refresh-devices" disabled={loading || refreshing}
                onClick={() => void refresh()} className="text-xs text-accent-400 disabled:text-zinc-600">
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
            <select id="android-device" aria-describedby="device-status" value={serial}
              disabled={loading || refreshing} onChange={event => select(event.target.value)}
              className="w-full min-w-0 truncate rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-200 disabled:opacity-60">
              <option value="" disabled>Choose a device</option>
              {serial && !devices.some(device => device.serial === serial) &&
                <option value={serial} disabled>{serial} · {refreshing ? "Checking…" : error ? "Status unavailable" : "Disconnected"}</option>}
              {devices.map(device => <option key={device.serial} value={device.serial} disabled={device.state !== "device"}>
                {device.model ? `${device.model} · ` : ""}{device.serial} · {deviceStateLabel(device.state)}
              </option>)}
            </select>
            <p id="device-status" role={error ? "alert" : "status"} className="text-xs leading-relaxed text-zinc-400">
              {refreshing ? "Checking connected devices…" : error?.message ?? deviceSelectionHint(devices, serial)}
            </p>
            {error && <details id="device-error-details" className="text-xs text-zinc-500">
              <summary className="cursor-pointer hover:text-zinc-300">Technical details</summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-zinc-900 p-3 font-mono">{error.details}</pre>
            </details>}
          </div>
          <label className="flex items-center justify-center gap-2.5 text-zinc-300 cursor-pointer">
            <input
              id="scan-as-root"
              type="checkbox"
              checked={rootMode}
              disabled={loading}
              onChange={(event) => onRootModeChange(event.target.checked)}
              className="size-4 shrink-0 accent-accent-500 cursor-pointer"
            />
            <span>Scan with root access (read-only)</span>
          </label>
          {rootMode && (
            <div className="w-full space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <label className="block text-xs text-zinc-400" htmlFor="root-scan-path">Scan location</label>
              <select
                id="root-scan-path"
                value={rootPath}
                disabled={loading}
                onChange={(event) => onRootPathChange(event.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-200"
              >
                <option value="/data">App and user data (/data)</option>
                <option value="/">Internal data and system (/)</option>
                <option value="/sdcard">Shared storage (/sdcard)</option>
              </select>
              <p className="text-xs leading-relaxed text-zinc-400">
                Requires a rooted device. Approve shell access on your phone if prompted.
                Internal scans exclude virtual filesystems and duplicate storage views;
                removable storage is excluded from the whole-device scan.
              </p>
            </div>
          )}
          {/* Connect Button */}
          <button
            id="btn-connect"
            onClick={onConnect}
            disabled={loading || !ready}
            className={`
              group relative w-full flex justify-center px-8 py-3 rounded-xl font-semibold text-sm
              transition-all duration-300 cursor-pointer
              ${loading || !ready
                ? "bg-zinc-800 text-zinc-500 cursor-wait"
                : "bg-gradient-to-r from-accent-600 to-accent-500 text-white hover:from-accent-500 hover:to-accent-400 hover:shadow-lg hover:shadow-accent-500/20 hover:-translate-y-0.5"
              }
            `}
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <Spinner size={16} />
                Connecting…
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <IconUsb />
                Connect Device
              </span>
            )}
          </button>
        </div>

        {/* Requirements hint */}
        <div className="max-w-xs text-center text-xs leading-relaxed text-zinc-500">
          <p>Connect your phone via USB with USB debugging enabled.</p>
        </div>
      </div>
    </div>
  );
}

