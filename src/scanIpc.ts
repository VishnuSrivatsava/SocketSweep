import { invoke, Channel } from "@tauri-apps/api/core";
import { parseDeleteResult, parseNodeDetail, parseScanView } from "./scanView";
import type { PageCursor, ScanScope } from "./scanView";
import { parseExportResult } from "./exportTransfer";
import { parseLargestFiles } from "./largestFilesSummary";
import { parseSearchResults } from "./searchResults";
import { parseFileTypes } from "./fileTypeSummary";
import { parseAppUsage } from "./appUsageSummary";
import { parseScanComparison } from "./scanComparison";

export async function getLargestFiles(scope: Parameters<typeof parseLargestFiles>[1], limit: number) {
  const raw = await invoke<string>("get_largest_files", { generation: scope.generation, revision: scope.revision, limit });
  return parseLargestFiles(raw, scope, limit);
}

export async function getSearchResults(scope: Parameters<typeof parseSearchResults>[1], query: string, skip: number) {
  const raw = await invoke<string>("get_search_results", { generation: scope.generation, revision: scope.revision, query, skip });
  return parseSearchResults(raw, scope, query, skip);
}

export async function getFileTypes(scope: Parameters<typeof parseFileTypes>[1]) {
  const raw = await invoke<string>("get_file_types", { generation: scope.generation, revision: scope.revision });
  return parseFileTypes(raw, scope);
}

export async function getScanComparison(scope: Parameters<typeof parseScanComparison>[1]) {
  const raw = await invoke<string>("get_scan_comparison", { generation: scope.generation, revision: scope.revision });
  return parseScanComparison(raw, scope);
}

export async function getScanView(scope: ScanScope, nodeId: number, cursor: PageCursor | null) {
  const raw = await invoke<string>("get_scan_view", { generation: scope.generation, revision: scope.revision, nodeId, cursor });
  return parseScanView(raw, scope, nodeId);
}

export async function getScanNode(scope: Parameters<typeof parseNodeDetail>[1], nodeId: number) {
  const raw = await invoke<string>("get_scan_node", { generation: scope.generation, revision: scope.revision, nodeId });
  return parseNodeDetail(raw, scope, nodeId);
}

export async function deleteScanNode(scope: ScanScope, nodeId: number) {
  const raw = await invoke<string>("delete_item", { generation: scope.generation, revision: scope.revision, nodeId });
  const result = parseDeleteResult(JSON.parse(raw));
  if (result.summary.generation !== scope.generation || result.summary.revision !== scope.revision + 1) {
    throw new Error("Deletion returned an unexpected scan snapshot");
  }
  return result;
}


export async function getAppUsage(scope: Parameters<typeof parseAppUsage>[1], skip: number) {
  const raw = await invoke<string>("get_app_usage", { generation: scope.generation, revision: scope.revision, skip });
  return parseAppUsage(raw, scope, skip);
}

export async function exportScanFile(
  scope: ScanScope, nodeId: number, exportId: string, onProgress: Channel<unknown>,
) {
  const raw = await invoke<string>("export_file", {
    generation: scope.generation, revision: scope.revision, nodeId, exportId, onProgress,
  });
  return parseExportResult(JSON.parse(raw));
}

export async function cancelExport(exportId: string) {
  await invoke("cancel_export", { exportId });
}
