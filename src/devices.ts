/** A read-only discovery record. Only Rust grants connection authority. */
export interface AndroidDevice {
  serial: string;
  state: string;
  model: string | null;
}

export function preserveDeviceSelection(current: string, devices: AndroidDevice[]): string {
  if (current) return current;
  const ready = devices.filter(device => device.state === "device");
  return ready.length === 1 ? ready[0].serial : "";
}

export function deviceStateLabel(state: string): string {
  switch (state) {
    case "device": return "Ready";
    case "offline": return "Offline";
    case "unauthorized": return "USB debugging not authorized";
    case "no permissions": return "No USB permission";
    default: return state;
  }
}

export function deviceSelectionHint(devices: AndroidDevice[], serial: string): string {
  const selected = devices.find(device => device.serial === serial);
  if (serial && !selected) return "Selected device is disconnected. Reconnect it or choose another device, then refresh.";
  if (selected?.state === "unauthorized") return "Unlock the selected phone and approve USB debugging, then refresh.";
  if (selected?.state === "offline") return "Selected device is offline. Reconnect it and refresh.";
  if (selected?.state === "no permissions") return "Check this computer's USB/udev permissions, then refresh.";
  if (selected && selected.state !== "device") return "Selected device is not ready for scanning. Reconnect it and refresh.";
  if (!devices.length) return "No devices found. Connect your phone and refresh.";
  if (!serial) return "Choose a ready device. Unlock and authorize phones marked unavailable, then refresh.";
  return "Only this device will be scanned.";
}

/** Diagnostic dumps belong in explicit details, never in the setup status. */
export function deviceDiscoveryMessage(details: string): string {
  const error = details.toLowerCase();
  if (["adb server didn't ack", "failed to start daemon", "cannot connect to daemon", "smartsocket", "address already in use"].some(text => error.includes(text))) {
    return "ADB could not start. Wait a moment and refresh. If it persists, close other Android tools and retry.";
  }
  if (error.includes("timed out")) return "Checking devices timed out. Reconnect the USB cable and refresh.";
  return "Couldn't check connected devices. Refresh to try again.";
}
