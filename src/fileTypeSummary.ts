import { sameScan } from "./scanView";
import type { ScanScope } from "./scanView";

export const FILE_TYPE_LABELS = {
  images: "Images",
  videos: "Videos",
  audio: "Audio",
  documents: "Documents",
  archives: "Archives",
  android_packages: "Android packages",
  no_extension: "No extension",
  other: "Other extensions",
} as const;
export type FileType = keyof typeof FILE_TYPE_LABELS;
export const FILE_TYPES = Object.keys(FILE_TYPE_LABELS) as FileType[];
export interface FileTypeCount { kind: FileType; files: number; size: number }
export interface FileTypesResponse extends ScanScope {
  total_files: number;
  total_size: number;
  categories: FileTypeCount[];
}
type Expected = ScanScope & { total_files: number; total_size: number };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Reject stale, malformed or non-reconciling summaries before showing totals. */
export function parseFileTypes(raw: string, expected: Expected): FileTypesResponse {
  const data: unknown = JSON.parse(raw);
  const invalid = () => new Error("File-type summary does not match this scan");
  if (!object(data) || typeof data.generation !== "string" || !count(data.revision)
    || !sameScan({ generation: data.generation, revision: data.revision }, expected)
    || !count(data.total_files) || !count(data.total_size)
    || data.total_files !== expected.total_files || data.total_size !== expected.total_size
    || !Array.isArray(data.categories) || data.categories.length !== FILE_TYPES.length) throw invalid();
  const categories = new Map<FileType, FileTypeCount>();
  for (const category of data.categories) {
    if (!object(category) || typeof category.kind !== "string"
      || !Object.prototype.hasOwnProperty.call(FILE_TYPE_LABELS, category.kind)
      || !count(category.files) || !count(category.size) || (category.files === 0 && category.size !== 0)) throw invalid();
    const kind = category.kind as FileType;
    if (categories.has(kind)) throw invalid();
    categories.set(kind, { kind, files: category.files, size: category.size });
  }
  const ordered = FILE_TYPES.map(kind => categories.get(kind)!);
  const files = ordered.reduce((sum, category) => sum + category.files, 0);
  const size = ordered.reduce((sum, category) => sum + category.size, 0);
  if (!count(files) || !count(size) || files !== data.total_files || size !== data.total_size) throw invalid();
  return { generation: data.generation, revision: data.revision, total_files: files, total_size: size, categories: ordered };
}
