const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Keep existing 1024-based labels and precision for ordinary file sizes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "Unknown";
  if (bytes === 0) return "0 B";

  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }

  // Scientific notation preserves tiny nonzero values and bounds huge output.
  const amount = value < 0.1 || value >= 1e21
    ? value.toExponential(1)
    : value.toFixed(unit === 0 && Number.isInteger(value) ? 0 : 1);
  return `${sign}${amount} ${UNITS[unit]}`;
}
