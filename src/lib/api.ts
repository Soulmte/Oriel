import type {
  ApiErrorBody,
  ConflictDto,
  ConflictPolicy,
  CleanupReportDto,
  CleanupResultDto,
  DirectorySizeDto,
  DriveDto,
  EntryDto,
  FileInfoDto,
  HealthResponse,
  InstalledAppListDto,
  AppSizeInfoDto,
  LeftoverCleanResultDto,
  LeftoverReportDto,
  ListResponse,
  LockListResponse,
  PreviewResponse,
  RecycleListResponse,
  PortListResponse,
  ProcessListResponse,
  UpdateInfoDto,
  SearchResponse,
  SpecialFolderDto,
  SystemInfoDto,
  TaskProgressDto,
  TransferKind,
} from "@oriel/shared";
import { DEFAULT_API_BASE_URL } from "@oriel/shared";

const BASE_URL = (
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? DEFAULT_API_BASE_URL
).replace(/\/+$/, "");

/** Only needed when the server was started with `ORIEL_TOKEN`. */
const API_TOKEN = ((import.meta.env.VITE_API_TOKEN as string | undefined) ?? "").trim();

export const API_BASE_URL = BASE_URL;

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(API_TOKEN ? { "X-Api-Token": API_TOKEN } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    if ((error as Error | undefined)?.name === "AbortError") throw error;
    throw new ApiRequestError(
      "无法连接本地文件服务，请确认 REST 服务已启动",
      "NETWORK_ERROR",
      0,
    );
  }

  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }

  if (!response.ok) {
    const detail = (body as ApiErrorBody | null)?.error;
    throw new ApiRequestError(
      detail?.message ?? `请求失败（HTTP ${response.status}）`,
      detail?.code ?? "HTTP_ERROR",
      response.status,
    );
  }

  return body as T;
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(payload) });
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
}

export const api = {
  health: () => request<HealthResponse>("/health"),

  systemInfo: () => request<SystemInfoDto>("/system/info"),

  drives: () => request<DriveDto[]>("/drives"),

  special: () => request<SpecialFolderDto[]>("/special"),

  /** Installed font families, for the appearance settings. */
  fonts: () => request<{ fonts: string[] }>("/system/fonts"),

  /** Listening TCP/UDP endpoints with their owning processes. */
  ports: (refresh = false) =>
    request<PortListResponse>(`/system/ports${refresh ? "?refresh=1" : ""}`),

  /** Ends the process that owns a port. */
  killPortProcess: (pid: number) =>
    post<{ ok: true; pid: number }>("/system/ports/kill", { pid }),

  /** Every running process with memory, threads and CPU time. */
  processes: () => request<ProcessListResponse>("/system/processes"),

  /** Ends a process and its children. */
  killProcess: (pid: number) =>
    post<{ ok: true; pid: number }>("/system/processes/kill", { pid }),

  /** Processes holding a handle on a file (Windows Restart Manager). */
  locks: (path: string) =>
    request<LockListResponse>(`/system/locks${query({ path })}`),

  /** Detailed cleanup analysis for one drive (categories, folders, big files). */
  cleanup: (drive = "C") =>
    request<CleanupReportDto>(`/system/cleanup${query({ drive })}`),

  /** Deletes the selected cleanup categories; only ids are sent. */
  cleanupRun: (ids: string[]) =>
    post<CleanupResultDto>("/system/cleanup/clean", { ids }),

  /** Progressive heatmap of one folder (SSE: meta, scan, node, done). */
  cleanupStreamUrl: (path: string) =>
    `${BASE_URL}/api/system/cleanup/stream${query({ path, token: API_TOKEN || undefined })}`,

  /** Cleanup categories measured in the background (SSE: category, done). */
  cleanupCategoriesUrl: () =>
    `${BASE_URL}/api/system/cleanup/categories${query({ token: API_TOKEN || undefined })}`,

  /** Installed programs from the uninstall registry. */
  apps: () => request<InstalledAppListDto>("/system/apps"),

  /** Measures the install folders of the given apps (cached on the server). */
  appSizes: (ids: string[]) =>
    post<{ sizes: Record<string, AppSizeInfoDto> }>("/system/apps/sizes", { ids }),

  /** Launches the program's own uninstaller (`quiet` uses QuietUninstallString). */
  uninstallApp: (id: string, quiet = false) =>
    post<{ ok: true; pid: number | null }>("/system/apps/uninstall", { id, quiet }),

  /** Whether the launched uninstaller is still running (`null`: not queryable). */
  appUninstallStatus: (pid: number) =>
    post<{ running: boolean | null }>("/system/apps/status", { pid }),

  /** Scans the registry keys and folders an uninstall may have left behind. */
  appLeftovers: (id: string) =>
    post<LeftoverReportDto>("/system/apps/leftovers", { id }),

  /**
   * Deletes leftover candidates by id. The server rescans first, so a caller
   * cannot pass an arbitrary key or path.
   */
  cleanAppLeftovers: (id: string, registry: string[], paths: string[]) =>
    post<LeftoverCleanResultDto>("/system/apps/clean", { id, registry, paths }),

  list: (path: string, showHidden = false) =>
    request<ListResponse>(`/fs/list${query({ path, showHidden })}`),

  stat: (path: string) => request<EntryDto>(`/fs/stat${query({ path })}`),

  /** Stats just the named children of a folder; used for watcher patches. */
  entries: (path: string, names: string[]) =>
    post<{ entries: EntryDto[] }>("/fs/entries", { path, names }),

  info: (path: string) => request<FileInfoDto>(`/fs/info${query({ path })}`),

  directorySize: (path: string) =>
    request<DirectorySizeDto>(`/fs/size${query({ path })}`),

  directorySizes: (paths: string[]) =>
    post<{ sizes: Record<string, DirectorySizeDto> }>("/fs/sizes", { paths }),

  preview: (path: string) =>
    request<PreviewResponse>(`/fs/preview${query({ path })}`),

  icons: (paths: string[]) =>
    post<{ icons: Record<string, string | null> }>("/fs/icons", { paths }),

  search: (
    path: string,
    searchText: string,
    options: { signal?: AbortSignal; limit?: number } = {},
  ) =>
    request<SearchResponse>(
      `/fs/search${query({
        path,
        q: searchText,
        limit: options.limit,
        token: API_TOKEN || undefined,
      })}`,
      { signal: options.signal },
    ),

  /**
   * Streaming search. Matches arrive while the walk is still running, and
   * closing the EventSource aborts the server-side walk immediately.
   */
  searchStreamUrl: (
    path: string,
    searchText: string,
    showHidden: boolean,
    scope: "folder" | "disk" | "all" = "folder",
  ) =>
    `${BASE_URL}/api/fs/search/stream${query({
      path,
      q: searchText,
      showHidden,
      scope,
      token: API_TOKEN || undefined,
    })}`,

  mkdir: (path: string, name: string) =>
    post<{ path: string }>("/fs/mkdir", { path, name }),

  newFile: (path: string, name: string, content = "") =>
    post<{ path: string }>("/fs/new-file", { path, name, content }),

  /** Creates a real OOXML package (docx/xlsx/pptx), not an empty file. */
  newOfficeFile: (path: string, name: string, template: "docx" | "xlsx" | "pptx") =>
    post<{ path: string }>("/fs/new-office-file", { path, name, template }),

  openTerminal: (path: string) => post<{ ok: true }>("/fs/terminal", { path }),

  rename: (path: string, newName: string) =>
    post<{ path: string }>("/fs/rename", { path, newName }),

  /** Renames many entries at once; the server runs them through temp names. */
  batchRename: (items: Array<{ path: string; name: string }>) =>
    post<{ renamed: Array<{ from: string; to: string }> }>("/fs/batch-rename", {
      items,
    }),

  copy: (sources: string[], target: string) =>
    post<{ paths: string[] }>("/fs/copy", { sources, target }),

  move: (sources: string[], target: string) =>
    post<{ paths: string[] }>("/fs/move", { sources, target }),

  remove: (paths: string[], permanent = false) =>
    post<{ deleted: number; permanent: boolean }>("/fs/delete", {
      paths,
      permanent,
    }),

  /** Writes the paths to the system clipboard as a file list (CF_HDROP). */
  clipboard: (paths: string[], cut = false) =>
    post<{ ok: true; count: number }>("/fs/clipboard", { paths, cut }),

  /** Reads the file list currently on the system clipboard. */
  readClipboard: () =>
    request<{ paths: string[]; cut: boolean }>("/fs/clipboard"),

  recycle: () => request<RecycleListResponse>("/recycle"),

  restoreRecycle: (ids: string[]) =>
    post<{ restored: string[]; skipped: Array<{ id: string; reason: string }> }>(
      "/recycle/restore",
      { ids },
    ),

  purgeRecycle: (ids: string[]) =>
    post<{ purged: number; skipped: Array<{ id: string; reason: string }> }>(
      "/recycle/purge",
      { ids },
    ),

  emptyRecycle: () => post<{ purged: number; skipped: number }>("/recycle/empty", {}),

  extractArchive: (
    path: string,
    target: string,
    policy: ConflictPolicy = "skip",
  ) => post<{ extracted: string[] }>("/archive/extract", { path, target, policy }),

  createArchive: (sources: string[], target: string, name: string) =>
    post<{ path: string }>("/archive/create", { sources, target, name }),

  openPath: (path: string) => post<{ ok: true }>("/fs/open", { path }),

  reveal: (path: string) => post<{ ok: true }>("/fs/reveal", { path }),

  downloadUrl: (path: string) => `${BASE_URL}/api/fs/download${query({ path })}`,

  /** Inline stream for <video>/<audio>; supports HTTP range requests. */
  mediaUrl: (path: string) => `${BASE_URL}/api/fs/media${query({ path })}`,

  /** Expands ~, %VAR% and $VAR to an absolute path. */
  resolvePath: (path: string) =>
    request<{ path: string; exists: boolean }>(`/fs/resolve${query({ path })}`),

  conflicts: (sources: string[], target: string) =>
    post<{ conflicts: ConflictDto[] }>("/fs/conflicts", { sources, target }),

  transfer: (
    kind: TransferKind,
    sources: string[],
    target: string,
    policy: ConflictPolicy,
  ) => post<TaskProgressDto>("/fs/transfer", { kind, sources, target, policy }),

  cancelTask: (id: string) =>
    post<{ cancelled: boolean }>(`/fs/tasks/${id}/cancel`, {}),

  pauseTask: (id: string) => post<{ paused: boolean }>(`/fs/tasks/${id}/pause`, {}),

  resumeTask: (id: string) =>
    post<{ resumed: boolean }>(`/fs/tasks/${id}/resume`, {}),

  retryTask: (id: string) => post<TaskProgressDto>(`/fs/tasks/${id}/retry`, {}),

  /** Latest GitHub release (unconfigured when the repo is not set). */
  updateCheck: (refresh = false) =>
    request<UpdateInfoDto>(`/app/update${refresh ? "?refresh=1" : ""}`),

  /** Downloads a release asset into the temp folder as a tracked task. */
  downloadUpdate: (urls: string | string[], name: string, size = 0) =>
    post<TaskProgressDto>("/app/update/download", {
      urls: Array.isArray(urls) ? urls : [urls],
      name,
      size,
    }),

  /** Single-shot progress read; used as a fallback when SSE drops an update. */
  task: (id: string) => request<TaskProgressDto>(`/fs/tasks/${id}`),

  eventsUrl: (watch: string) =>
    `${BASE_URL}/api/events${query({ watch, token: API_TOKEN || undefined })}`,

  /** Cached, resized preview for image entries. `version` busts the URL when the file changes. */
  thumbnailUrl: (path: string, version: number, size = 256) =>
    `${BASE_URL}/api/fs/thumbnail${query({ path, size, v: Math.round(version) })}`,
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Waits until the bundled service answers. The installer starts Node from Rust
 * while the webview paints immediately, so the first health probe can arrive a
 * few seconds early; a single probe used to leave the app stuck on
 * “服务未连接” for the rest of the session.
 */
export async function waitForService(timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      await api.health();
      return true;
    } catch {
      // Back off gently: 250 ms, 500 ms, 1 s, then every second.
      const delay = Math.min(1000, 250 * 2 ** attempt);
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return false;
}
