import { isCount, isRecord, sameScan } from "./scanView";
import type { ScanResponse, ScanScope } from "./scanView";

interface PackageUsage { package_id: string; scanned_size: number; locations: number }
export interface AppUsageResponse extends ScanScope {
  total_size: number;
  attributed_size: number;
  unattributed_size: number;
  total_packages: number;
  errors: number;
  skipped: number;
  skip: number;
  next_skip: number | null;
  packages: PackageUsage[];
}
type Expected = Pick<ScanResponse, "generation" | "revision" | "total_size" | "errors" | "skipped">;

export function parseAppUsage(raw: string, expected: Expected, skip: number): AppUsageResponse {
  const data: unknown = JSON.parse(raw);
  const invalid = () => new Error("Package-folder usage does not match this scan");
  if (!isRecord(data) || typeof data.generation !== "string" || !isCount(data.revision)
    || !sameScan({ generation: data.generation, revision: data.revision }, expected)
    || data.total_size !== expected.total_size || data.errors !== expected.errors || data.skipped !== expected.skipped
    || !isCount(data.attributed_size) || !isCount(data.unattributed_size)
    || data.attributed_size + data.unattributed_size !== expected.total_size
    || !isCount(data.total_packages) || data.skip !== skip || !isCount(skip)
    || skip > data.total_packages || (skip > 0 && skip === data.total_packages)
    || !Array.isArray(data.packages) || data.packages.length !== Math.min(100, data.total_packages - skip)) throw invalid();
  let previous = "";
  let pageBytes = 0;
  const packages = data.packages.map((row: unknown) => {
    if (!isRecord(row) || typeof row.package_id !== "string" || row.package_id.length > 255
      || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(row.package_id)
      || row.package_id <= previous || !isCount(row.scanned_size) || !isCount(row.locations) || row.locations === 0) throw invalid();
    previous = row.package_id;
    pageBytes += row.scanned_size;
    return { package_id: row.package_id, scanned_size: row.scanned_size, locations: row.locations };
  });
  const end = skip + packages.length;
  const next = end < data.total_packages ? end : null;
  if (data.next_skip !== next || !isCount(pageBytes) || pageBytes > data.attributed_size
    || (skip === 0 && next === null && pageBytes !== data.attributed_size)) throw invalid();
  return {
    generation: data.generation, revision: data.revision, total_size: expected.total_size,
    attributed_size: data.attributed_size, unattributed_size: data.unattributed_size,
    total_packages: data.total_packages, errors: expected.errors, skipped: expected.skipped,
    skip, next_skip: next, packages,
  };
}
