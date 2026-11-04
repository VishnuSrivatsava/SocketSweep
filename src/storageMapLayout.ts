import type { ScanView } from "./scanView";

type Tile = ScanView["chart"][number];
type Bounds = { x: number; y: number; width: number; height: number };

export function layoutStorageMap(chart: readonly Tile[], total: number, width: number, height: number) {
  const tiles = chart.filter(tile => tile.size > 0);
  const layout: (Tile & Bounds)[] = [];
  if (!tiles.length || width <= 0 || height <= 0 || tiles.reduce((sum, tile) => sum + tile.size, 0) !== total) return layout;

  function divide(start: number, end: number, bytes: number, bounds: Bounds) {
    if (end - start === 1) {
      layout.push({ ...tiles[start], ...bounds });
      return;
    }

    // Split at the nearest byte midpoint, then divide along the longer side.
    let split = start + 1;
    let firstBytes = tiles[start].size;
    while (split < end - 1 && Math.abs(bytes / 2 - firstBytes - tiles[split].size) < Math.abs(bytes / 2 - firstBytes)) {
      firstBytes += tiles[split++].size;
    }
    const fraction = firstBytes / bytes;
    if (bounds.width >= bounds.height) {
      const left = bounds.width * fraction;
      divide(start, split, firstBytes, { ...bounds, width: left });
      divide(split, end, bytes - firstBytes, { ...bounds, x: bounds.x + left, width: bounds.width - left });
    } else {
      const top = bounds.height * fraction;
      divide(start, split, firstBytes, { ...bounds, height: top });
      divide(split, end, bytes - firstBytes, { ...bounds, y: bounds.y + top, height: bounds.height - top });
    }
  }

  divide(0, tiles.length, total, { x: 0, y: 0, width, height });
  return layout;
}
