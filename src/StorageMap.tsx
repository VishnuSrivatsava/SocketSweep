import { useLayoutEffect, useRef, useState } from "react";
import { formatBytes } from "./formatBytes";
import type { ScanView } from "./scanView";
import { layoutStorageMap } from "./storageMapLayout";

const colors = ["#0d9488", "#0284c7", "#4f46e5", "#7c3aed", "#c026d3", "#e11d48", "#ea580c", "#ca8a04"];

export function StorageMap({ page, busy, onZoom }: {
  page: ScanView | undefined;
  busy: boolean;
  onZoom: (id: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const tiles = page ? layoutStorageMap(page.chart, page.node.size, size.width, size.height) : [];
  return <div className="glass-card rounded-xl p-2 w-full h-full">
    <div ref={container} className="h-full relative">
      {page && !page.chart.length && <p className="text-xs text-zinc-400 p-2">No scanned child bytes to display.</p>}
      <svg className="absolute inset-0 w-full h-full" role="group" aria-label="Storage map of scanned bytes">
        {tiles.map(({ node_id, name, size, x, y, width, height }, index) => {
          const interactive = node_id !== null && !busy;
          const label = `${name} · ${formatBytes(size)}`;
          return <g key={node_id ?? "other"} role={node_id === null ? "img" : "button"}
            aria-label={label} aria-disabled={node_id !== null && busy ? true : undefined}
            tabIndex={interactive ? 0 : undefined}
            className={interactive ? "cursor-pointer focus-visible:brightness-125" : undefined}
            onClick={interactive ? () => onZoom(node_id) : undefined}
            onKeyDown={interactive ? event => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onZoom(node_id);
            } : undefined}>
            <title>{label}</title>
            <rect x={x} y={y} width={width} height={height} fill={node_id === null ? "#52525b" : colors[index % colors.length]} stroke="#ffffff20" />
            {width > 46 && height > 22 && <svg x={x} y={y} width={width} height={height} overflow="hidden" aria-hidden="true" className="pointer-events-none">
              <text x={6} y={16} fill="white" fontSize={11} fontWeight={600}>{name}</text>
              {height > 36 && <text x={6} y={30} fill="white" fontSize={9}>{formatBytes(size)}</text>}
            </svg>}
          </g>;
        })}
      </svg>
    </div>
  </div>;
}
