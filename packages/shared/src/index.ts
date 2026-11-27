/**
 * Contract shared by the REST server and the web client.
 * Keep this package dependency-free: it is imported by Node, Vite and tsup.
 */

export const APP_NAME = "Oriel";
export const APP_VERSION = "0.1.8";
export const DEFAULT_API_PORT = 8787;
export const DEFAULT_API_BASE_URL = `http://127.0.0.1:${DEFAULT_API_PORT}`;

/** Public project pages, linked from Settings → About. */
export const GITHUB_URL = "https://github.com/Soulmte/Oriel";
export const GITEE_URL = "https://gitee.com/rain-drops/oriel";

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
  /** Preferred download URL (CDN, then Gitee, then GitHub). */
  url: string;
  /** All mirrors in the order they should be tried. */
  urls?: string[];
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
  /** Release title from GitHub/Gitee, e.g. `Oriel 0.1.2`. */
  releaseName?: string | null;
  /** Release notes in Markdown. */
  notes: string | null;
  /** GitHub compare link for this release, when the body carried one. */
  compareUrl?: string | null;
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

/** One listening TCP/UDP endpoint and the process that owns it. */
export interface PortEntryDto {
  protocol: "TCP" | "UDP";
  /** `0.0.0.0`, `127.0.0.1`, `::`, … */
  address: string;
  port: number;
  pid: number;
  /** Executable name without the extension, e.g. `chrome`. */
  process: string;
  /** Full executable path when Windows exposes it. */
  path: string | null;
  /** True for the service that powers Oriel itself. */
  oriel: boolean;
}

export interface PortListResponse {
  items: PortEntryDto[];
  platform: string;
  /** Populated when the platform cannot enumerate endpoints. */
  note: string | null;
}

/** One running process, from the Windows process manager. */
export interface ProcessEntryDto {
  pid: number;
  ppid: number;
  /** Image name with extension, e.g. `chrome.exe`. */
  name: string;
  /** Full image path when Windows exposes it. */
  path: string | null;
  /** Working set in bytes. */
  memory: number;
  threads: number;
  /** Kernel + user milliseconds; the client derives CPU% between samples. */
  cpuMs: number;
  /** Milliseconds since the Unix epoch. */
  startedMs: number;
  /** Command line, best effort (needs PROCESS_VM_READ). */
  cmdline: string | null;
  /** True for system images the app refuses to end. */
  protected: boolean;
  /** True for the service that powers Oriel itself. */
  oriel: boolean;
}

export interface ProcessListResponse {
  items: ProcessEntryDto[];
  servicePid: number;
}

/** One process holding a handle on a file, via the Windows Restart Manager. */
export interface LockEntryDto {
  pid: number;
  name: string;
  path: string | null;
  appType: "window" | "service" | "console" | "explorer" | "critical" | "unknown";
  /** Service short name for services, e.g. `wuauserv`. */
  service: string | null;
  restartable: boolean;
  protected: boolean;
  oriel: boolean;
}

export interface LockListResponse {
  path: string;
  items: LockEntryDto[];
}

/** One cleanup category, with the paths it may remove. */
export interface CleanupCategoryDto {
  id: string;
  title: string;
  detail: string;
  /** `safe` for regenerated caches, `caution` when deleting loses something. */
  risk: "safe" | "caution";
  needsAdmin: boolean;
  available: boolean;
  size: number;
  files: number;
  /** True when the size walk hit its time budget. */
  partial: boolean;
  paths: string[];
}

export interface CleanupFolderDto {
  name: string;
  path: string;
  size: number;
  files: number;
  partial: boolean;
}

export interface CleanupLargeFileDto {
  name: string;
  path: string;
  size: number;
  /** pagefile.sys and friends: shown for context, never suggested for deletion. */
  system: boolean;
}

export interface CleanupReportDto {
  drive: string;
  total: number;
  free: number;
  used: number;
  /** Whether the app runs elevated; system-level categories may fail without it. */
  elevated: boolean;
  categories: CleanupCategoryDto[];
  folders: CleanupFolderDto[];
  largeFiles: CleanupLargeFileDto[];
  /** True when part of the drive could not be measured in time. */
  partial: boolean;
  scannedAt: number;
}

/** Header of a heatmap stream: the folder being viewed and its volume. */
export interface CleanupMetaDto {
  path: string;
  parent: string | null;
  drive: string;
  total: number;
  free: number;
  used: number;
  elevated: boolean;
}

/** One rectangle in the heatmap; partial sizes grow while the stream runs. */
export interface CleanupNodeDto {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  files: number;
  /** False while the subtree is still being measured. */
  complete: boolean;
  /** True when the time budget cut the measurement short. */
  partial: boolean;
}

export interface CleanupDoneDto {
  partial: boolean;
  scannedAt: number;
}

export interface CleanupItemResultDto {
  id: string;
  title: string;
  freed: number;
  deleted: number;
  failed: number;
  errors: string[];
}

export interface CleanupResultDto {
  freed: number;
  deleted: number;
  failed: number;
  items: CleanupItemResultDto[];
}

/** One entry from the Windows uninstall registry. */
export interface InstalledAppDto {
  id: string;
  name: string;
  version: string;
  publisher: string;
  installLocation: string;
  uninstallString: string;
  quietUninstallString: string;
  estimatedSize: number;
  /** Best known installed size: measured when available, otherwise the estimate. */
  size: number;
  /** True when the size walk hit its time budget. */
  sizePartial: boolean;
  /** True when `size` came from walking the install folder. */
  sizeMeasured: boolean;
  iconPath: string;
  /** Already formatted as `YYYY-MM-DD`. */
  installDate: string;
  scope: "machine" | "user";
}

/** Result of measuring one app's install folder. */
export interface AppSizeInfoDto {
  size: number;
  partial: boolean;
  measured: boolean;
}

export interface InstalledAppListDto {
  items: InstalledAppDto[];
  elevated: boolean;
  scannedAt: number;
}

/** A registry key or folder one uninstall may have left behind. */
export interface LeftoverItemDto {
  id: string;
  kind: "registry" | "directory" | "file";
  label: string;
  detail: string;
  size: number;
  files: number;
  needsAdmin: boolean;
  /** True when the size walk hit its time budget. */
  partial: boolean;
  risk: "safe" | "caution";
}

export interface LeftoverReportDto {
  app: InstalledAppDto;
  items: LeftoverItemDto[];
  total: number;
  elevated: boolean;
  scannedAt: number;
}

export interface LeftoverCleanItemDto {
  id: string;
  label: string;
  ok: boolean;
  freed: number;
  deleted: number;
  error: string | null;
}

export interface LeftoverCleanResultDto {
  freed: number;
  deleted: number;
  failed: number;
  items: LeftoverCleanItemDto[];
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
