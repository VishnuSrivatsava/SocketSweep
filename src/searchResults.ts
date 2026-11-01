import { sameScan, isRecord, isCount, isU32, parseNodeReference } from "./scanView";
import type { ScanScope, ScanResponse, NodeDetail } from "./scanView";

export const MAX_SEARCH_RESULTS = 100;
export interface SearchResponse extends ScanScope {
  query: string;
  skip: number;
  has_more: boolean;
  results: Pick<NodeDetail, "node" | "path">[];
}
type Expected = Pick<ScanResponse, "generation" | "revision" | "root_path" | "read_only" | "total_size">;
/** Validate bounded, scoped search rows before rendering action controls. */
export function parseSearchResults(raw: string, expected: Expected, query: string, skip: number): SearchResponse {
  const data: unknown = JSON.parse(raw);
  const invalid = () => new Error("Search response does not match this scan");
  if (!isRecord(data) || typeof data.generation !== "string" || !isU32(data.revision)
    || !sameScan({ generation: data.generation, revision: data.revision }, expected)
    || typeof data.query !== "string" || data.query !== query
    || !isCount(skip) || !isU32(skip) || !isCount(data.skip) || data.skip !== skip
    || typeof data.has_more !== "boolean"
    || !Array.isArray(data.results) || data.results.length > MAX_SEARCH_RESULTS
    || (data.results.length < MAX_SEARCH_RESULTS && data.has_more)) throw invalid();
  const results: SearchResponse["results"] = [];
  const seen = new Set<number>();
  const paths = new Set<string>();
  for (const row of data.results) {
    const reference = parseNodeReference(row, expected);
    const { node, path } = reference;
    if (node.id === 0 || node.parent_id === null || seen.has(node.id) || paths.has(path)) throw invalid();
    seen.add(node.id);
    paths.add(path);
    results.push(reference);
  }
  return { generation: data.generation, revision: data.revision, query, skip, has_more: data.has_more, results };
}
