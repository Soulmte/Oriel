/**
 * Contract shared by the REST server and the web client.
 * Keep this package dependency-free: it is imported by Node, Vite and tsup.
 */

export const APP_NAME = "Oriel";
export const APP_VERSION = "0.1.2";
export const DEFAULT_API_PORT = 8787;
export const DEFAULT_API_BASE_URL = `http://127.0.0.1:${DEFAULT_API_PORT}`;

export type EntryKind = "file" | "directory";
export type ViewMode = "grid" | "list";
export type SortKey = "name" | "date" | "size" | "kind";
export type SortDirection = "asc" | "desc";
export type DriveKind = "fixed" | "removable" | "network" | "unknown";

export interface EntryDto {
  name: string;
  /** Absolute, normalized path. */
  path: string;
  kind: EntryKind;
  /** Bytes for files, 0 for directories. */
  size: number;
  mtimeMs: number;
  /** Creation time when the platform exposes it, otherwise mtime. */
  birthtimeMs: number;
  /** Lower-case extension without the dot, empty for directories. */
  ext: string;
  hidden: boolean;
  readonly: boolean;
  isLink: boolean;
}

export interface ListResponse {
  path: string;
  parent: string | null;
  entries: EntryDto[];
}

export interface DriveDto {
  /** e.g. `C:\` */
  path: string;
  /** e.g. `C:` */
  name: string;
  /** Volume label, e.g. `Windows` or `本地磁盘` */
  label: string;
  total: number;
  free: number;
  used: number;
  kind: DriveKind;
}

export interface SpecialFolderDto {
  id: string;
  name: string;
  path: string;
  /** Icon key understood by the web client. */
  icon: string;
}

export interface SystemInfoDto {
  platform: string;
  release: string;
  hostname: string;
  home: string;
  sep: string;
  appVersion: string;
  nodeVersion: string;
}

export interface SearchResponse {
  path: string;
  query: string;
  entries: EntryDto[];
  truncated: boolean;
  scanned: number;
  /** True when the scan stopped because it ran out of time, not results. */
  timedOut?: boolean;
}

/** Server-sent event payloads for `GET /api/fs/search/stream`. */
export interface SearchMatchEvent {
  entries: EntryDto[];
}

export interface SearchDoneEvent {
  path: string;
  query: string;
  scanned: number;
  total: number;
  truncated: boolean;
  timedOut: boolean;
}

export interface FileInfoDto {
  path: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  readonly: boolean;
  isLink: boolean;
  image?: { width: number; height: number; format?: string };
  pdf?: { pages: number };
}

export interface DirectorySizeDto {
  path: string;
  size: number;
  files: number;
  dirs: number;
  /** True when the walk hit its time or entry budget. */
  partial: boolean;
}

export type TransferKind = "copy" | "move";
/** What a task in the operations center does. */
export type TaskKind = TransferKind | "download";
export type ConflictPolicy = "overwrite" | "skip" | "rename" | "keep-both";
export type TaskStatus =
  | "queued"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export interface TaskProgressDto {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  total: number;
  done: number;
  current: string | null;
  error?: string;
  created: string[];
  /** Bytes copied so far. For `move` this stays 0 until a cross-volume copy starts. */
  bytesDone?: number;
  /** Estimated total bytes, 0 when unknown (same-volume moves). */
  bytesTotal?: number;
}

export interface ConflictDto {
  source: string;
  destination: string;
}

export interface PreviewResponse {
  path: string;
  name: string;
  ext: string;
  encoding: "utf8" | "binary";
  content: string | null;
  size: number;
  truncated: boolean;
}

/** One entry of the Windows recycle bin ($Recycle.Bin/$I sidecar). */
export interface RecycleItemDto {
  /** Opaque handle: the absolute path of the `$I` metadata file. */
  id: string;
  /** Base name of the original entry. */
  name: string;
  /** Where the entry came from, used by restore. */
  originalPath: string;
  size: number;
  /** Milliseconds since epoch (0 when the sidecar has no timestamp). */
  deletedAt: number;
  kind: "file" | "directory";
  /** Drive root, e.g. `C:\`. */
  drive: string;
}

export interface RecycleListResponse {
  items: RecycleItemDto[];
  total: number;
  /** Drives whose bin could not be read (permissions). */
  skippedDrives: string[];
}

/** Result of the in-app update check against GitHub releases. */
export interface UpdateAssetDto {
  name: string;
  /** Preferred download URL (CDN, then GitHub, then Gitee). */
  url: string;
  /** Gitee mirror for the same file, when the release is mirrored. */
  mirrorUrl?: string | null;
  /** Original GitHub asset, used as the last fallback. */
  sourceUrl?: string | null;
  size: number;
}

export interface UpdateInfoDto {
  /** False when the build has no repository configured. */
  configured: boolean;
  current: string;
  latest: string | null;
  /** True when `latest` is newer than `current`. */
  newer: boolean;
  url: string | null;
  /** Release notes in Markdown. */
  notes: string | null;
  publishedAt: string | null;
  assets: UpdateAssetDto[];
  error?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface HealthResponse {
  ok: boolean;
  name: string;
  version: string;
  uptime: number;
}

export const SEARCH_MIN_QUERY_LENGTH = 1;
/** Results a single search may return before it stops looking. */
export const SEARCH_RESULT_LIMIT = 500;
/** Wall-clock budget for one search; a whole-disk query cannot run forever. */
export const SEARCH_BUDGET_MS = 10_000;
export const PREVIEW_BYTE_LIMIT = 512 * 1024;

/** Errors we deliberately surface to the UI with a stable code. */
export const ERROR_CODES = {
  invalidPath: "INVALID_PATH",
  invalidName: "INVALID_NAME",
  notFound: "NOT_FOUND",
  permissionDenied: "PERMISSION_DENIED",
  notADirectory: "NOT_A_DIRECTORY",
  conflict: "CONFLICT",
  invalidTarget: "INVALID_TARGET",
  unsafeOperation: "UNSAFE_OPERATION",
  internal: "INTERNAL",
} as const;
