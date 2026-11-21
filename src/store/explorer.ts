import { create } from "zustand";
import { toast } from "@heroui/react";
import type {
  ConflictDto,
  ConflictPolicy,
  DirectorySizeDto,
  DriveDto,
  EntryDto,
  RecycleItemDto,
  SearchDoneEvent,
  SearchMatchEvent,
  SortDirection,
  SortKey,
  SpecialFolderDto,
  SystemInfoDto,
  TaskProgressDto,
  TransferKind,
  ViewMode,
} from "@oriel/shared";
import { api, errorMessage } from "../lib/api";
import {
  invokeShellVerb,
  isNativeShellAvailable,
  listShellVerbs,
  shellDelete,
} from "../lib/shell";
import type { ShellVerb } from "../lib/shell";
import {
  readContextMenuPrefs,
  writeContextMenuPrefs,
} from "../lib/contextMenuPrefs";
import type { ContextMenuPrefs } from "../lib/contextMenuPrefs";
import { readCachedIcons, pruneCachedIcons, writeCachedIcons } from "../lib/iconCache";
import type { CachedShellIcon } from "../lib/iconCache";
import {
  basename,
  parentPath,
  samePath,
  sortEntriesCached,
  startsWithPath,
} from "../lib/format";
import type { GroupKey } from "../lib/grouping";
import { DEFAULT_APPEARANCE, readAppearance, writeAppearance } from "../lib/appearance";
import {
  buildArchivePath,
  isArchivePath,
  isBrowsableArchive,
  parseArchivePath,
} from "../lib/archivePath";
import {
  folderViewFor,
  rememberFolderView,
  resetFolderViews,
  scheduleFolderViewsFlush,
} from "../lib/folderViews";
import type { AppearancePrefs } from "../lib/appearance";

export type DialogState =
  | { kind: "new-folder" }
  | { kind: "new-file"; extension: string; label: string; content: string }
  | { kind: "rename"; entry: EntryDto }
  | { kind: "batch-rename"; paths: string[] }
  | { kind: "error"; message: string }
  | { kind: "confirm-remove"; paths: string[]; permanent: boolean }
  | { kind: "confirm-purge"; ids: string[]; all: boolean }
  | {
      kind: "conflict";
      action: TransferKind;
      sources: string[];
      target: string;
      conflicts: ConflictDto[];
    }
  | null;

/** A reversible action kept on the undo stack. */
export interface UndoAction {
  label: string;
  run: () => Promise<void>;
}

export interface ContextMenuState {
  x: number;
  y: number;
  entry?: EntryDto;
}

export type Route = "files" | "settings" | "recycle";
export type StartLocation = "last" | "home";

interface ClipboardState {
  mode: "copy" | "cut";
  paths: string[];
}

interface ExplorerState {
  route: Route;
  ready: boolean;
  system: SystemInfoDto | null;
  drives: DriveDto[];
  specials: SpecialFolderDto[];

  path: string;
  parent: string | null;
  entries: EntryDto[];
  loading: boolean;
  error: string | null;

  history: string[];
  historyIndex: number;

  selected: string[];
  anchor: string | null;

  view: ViewMode;
  sortKey: SortKey;
  sortDir: SortDirection;
  groupKey: GroupKey;
  /** Presentation-only preferences (accent, scale, motion, grid metrics). */
  appearance: AppearancePrefs;
  /** Bumped when the user resets the pane widths, so panes can reset local state. */
  layoutEpoch: number;
  /** Scroll offset to restore after a navigation (consumed by the view). */
  pendingScrollTop: number | null;
  resetLayout: () => void;
  rememberScrollTop: (top: number) => void;
  /** Per-folder view/sort/group/scroll memory. */
  forgetFolderViews: () => void;
  /** Extract an archive entry / archive into a real folder next to it. */
  extractArchive: (target: string, mode: "here" | "folder") => Promise<void>;
  /** Compress the current selection into a zip next to it. */
  compressSelection: () => Promise<void>;
  /** Download a release asset and track it in the operations center. */
  downloadUpdate: (url: string, name: string) => Promise<string | null>;
  showHidden: boolean;
  startLocation: StartLocation;
  /** Finder-style preview panel on the right edge. */
  previewOpen: boolean;
  togglePreview: () => void;
  setPreviewOpen: (open: boolean) => void;

  /** Background copy/move tasks keyed by id. */
  tasks: Record<string, TaskProgressDto>;
  activeTaskId: string | null;
  /** Byte-per-second per task, derived from successive progress events. */
  taskSpeeds: Record<string, number>;
  operationsOpen: boolean;
  toggleOperations: () => void;
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  retryTask: (id: string) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  clearFinishedTasks: () => void;
  undoStack: UndoAction[];
  undo: () => Promise<void>;
  pushUndo: (action: UndoAction) => void;
  startTransfer: (
    kind: TransferKind,
    paths: string[],
    target: string,
  ) => Promise<void>;
  submitTransfer: (
    kind: TransferKind,
    paths: string[],
    target: string,
    policy: ConflictPolicy,
  ) => Promise<void>;
  applyTask: (task: TaskProgressDto) => void;
  refreshFromWatcher: () => Promise<void>;

  recycle: {
    items: RecycleItemDto[];
    total: number;
    loading: boolean;
    skippedDrives: string[];
  };
  openRecycle: () => Promise<void>;
  closeRecycle: () => void;
  loadRecycle: () => Promise<void>;
  restoreRecycle: (ids: string[]) => Promise<void>;
  purgeRecycle: (ids: string[]) => Promise<void>;
  emptyRecycle: () => Promise<void>;

  query: string;
  results: EntryDto[] | null;
  searching: boolean;
  searchTruncated: boolean;
  /** Entries visited by the current search; shown while it is still running. */
  searchScanned: number;
  /** The search stopped on its time budget instead of on its result limit. */
  searchTimedOut: boolean;

  clipboard: ClipboardState | null;
  shellIcons: Record<string, string>;
  /** Cached recursive folder sizes, keyed by path. */
  folderSizes: Record<string, DirectorySizeDto>;
  /**
   * Drag bookkeeping. While a drag is in flight the browser cancels it the
   * moment the source element leaves the document, so the listing that owns
   * the source has to stay mounted even after hover-navigation moves on.
   */
  dragging: boolean;
  frozenEntries: EntryDto[] | null;
  frozenPath: string | null;
  beginDrag: () => void;
  endDrag: () => void;
  dialog: DialogState;
  contextMenu: ContextMenuState | null;
  /** Which entries the context menu shows. */
  contextMenuPrefs: ContextMenuPrefs;
  /** Shell verbs discovered for the entry under the cursor. */
  shellVerbs: ShellVerb[];
  setContextMenuPref: <K extends keyof ContextMenuPrefs>(
    key: K,
    value: ContextMenuPrefs[K],
  ) => void;
  toggleContextMenuItem: (id: string) => void;
  toggleShellVerb: (label: string) => void;
  resetContextMenuPrefs: () => void;
  loadShellVerbs: (path: string) => Promise<void>;
  runShellVerb: (path: string, id: number) => Promise<void>;

  init: () => Promise<void>;
  navigate: (
    target: string,
    options?: { history?: "push" | "replace" | "none"; index?: number },
  ) => Promise<void>;
  goBack: () => void;
  goForward: () => void;
  goUp: () => void;
  reload: () => void;

  setView: (view: ViewMode) => void;
  setSort: (key: SortKey) => void;
  setGroup: (key: GroupKey) => void;
  setAppearance: <K extends keyof AppearancePrefs>(
    key: K,
    value: AppearancePrefs[K],
  ) => void;
  resetAppearance: () => void;
  toggleHidden: () => void;
  setShowHidden: (value: boolean) => void;
  setStartLocation: (value: StartLocation) => void;
  resetPreferences: () => void;
  openSettings: () => void;
  closeSettings: () => void;

  selectOnly: (path: string) => void;
  toggleSelect: (path: string) => void;
  selectRange: (path: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  moveSelection: (delta: number) => void;

  openEntry: (entry: EntryDto) => Promise<void>;
  reveal: (target: string) => Promise<void>;

  setQuery: (query: string) => void;
  loadShellIcons: (entries: EntryDto[]) => Promise<void>;
  /** Queues folder sizes; calls inside one tick are batched into one request. */
  requestFolderSizes: (paths: string[]) => void;

  copySelection: (mode: "copy" | "cut") => void;
  paste: () => Promise<void>;
  /** Mirrors the Windows clipboard into the in-app clipboard state. */
  syncClipboard: () => Promise<void>;
  /** Moves (or copies, with Ctrl held) dropped paths into `target`. */
  dropPaths: (paths: string[], target: string, kind?: TransferKind) => Promise<void>;
  /** Applies a watcher patch for just the names that changed. */
  patchEntries: (names: string[]) => Promise<void>;

  openDialog: (dialog: DialogState) => void;
  closeDialog: () => void;

  createFolder: (name: string) => Promise<boolean>;
  createFile: (name: string, content?: string) => Promise<boolean>;
  openTerminal: () => Promise<void>;
  renameEntry: (name: string) => Promise<boolean>;
  /** Applies an already-previewed batch rename (paths + final names). */
  batchRename: (items: Array<{ path: string; name: string }>) => Promise<boolean>;
  removePaths: (paths: string[], permanent?: boolean) => Promise<void>;
  /** Performs the delete after the confirmation dialog was accepted. */
  performRemove: (paths: string[], permanent: boolean) => Promise<void>;

  setContextMenu: (menu: ContextMenuState | null) => void;
  notify: (message: string) => void;
}

const LAST_PATH_KEY = "oriel:last-path";

/** In-memory shell icon entries kept per session before evicting the oldest. */
const MAX_SHELL_ICONS = 800;

function capShellIcons(map: Record<string, string>): Record<string, string> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_SHELL_ICONS) return map;

  const trimmed = { ...map };
  for (const key of keys.slice(0, keys.length - MAX_SHELL_ICONS)) {
    delete trimmed[key];
  }
  return trimmed;
}

/**
 * Entries whose own Windows icon says more than a generic document glyph:
 * shortcuts and executables, plus Office/PDF/ebook documents.
 */
const SHELL_ICON_EXTENSIONS = new Set([
  "lnk",
  "url",
  "exe",
  "msi",
  "msix",
  "ico",
  "appref-ms",
  "doc",
  "docx",
  "docm",
  "dotx",
  "rtf",
  "odt",
  "xls",
  "xlsx",
  "xlsm",
  "csv",
  "ods",
  "ppt",
  "pptx",
  "pptm",
  "ppsx",
  "odp",
  "pdf",
  "epub",
  "mobi",
  "azw",
  "azw3",
  "fb2",
  "djvu",
  "zip",
  "rar",
  "7z",
]);

const PREF = {
  view: "oriel:pref-view",
  sortKey: "oriel:pref-sort-key",
  sortDir: "oriel:pref-sort-dir",
  showHidden: "oriel:pref-show-hidden",
  startLocation: "oriel:pref-start-location",
  preview: "oriel:pref-preview",
  group: "oriel:pref-group",
} as const;

function readString<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  try {
    const raw = localStorage.getItem(key);
    return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "true";
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: string | boolean): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Preferences are best-effort; private windows can reject storage.
  }
}

let initStarted = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
/** The live search stream; closing it aborts the walk on the server. */
let searchSource: EventSource | null = null;
/** Monotonic token: only the newest search may write its results. */
let searchSeq = 0;

function closeSearchStream(): void {
  searchSource?.close();
  searchSource = null;
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = undefined;
  }
}
/** Monotonic token: only the newest `navigate` may commit its response. */
let navSeq = 0;

function ordered(state: ExplorerState): EntryDto[] {
  const source =
    state.query.trim() && state.results !== null ? state.results : state.entries;
  return sortEntriesCached(source, state.sortKey, state.sortDir);
}

function clipboardEquals(
  a: ClipboardState | null,
  b: ClipboardState | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.mode === b.mode &&
    a.paths.length === b.paths.length &&
    a.paths.every((item, index) => item === b.paths[index])
  );
}

type SetState = (partial: Partial<ExplorerState>) => void;
type GetState = () => ExplorerState;

let fsSource: EventSource | null = null;
let taskSource: EventSource | null = null;
let watchedPath = "";
let watcherRefreshTimer: ReturnType<typeof setTimeout> | null = null;
/** Names reported since the last flush; empty means "unknown, do a full read". */
let watcherPendingNames: string[] = [];

/**
 * Shell verbs are cached per entry *kind* (folder / file by extension). The
 * first right-click of a kind waits for the probe, every later one opens the
 * menu instantly — otherwise the menu visibly grows a moment after it appears.
 */
const shellVerbCache = new Map<string, ShellVerb[]>();
const SHELL_VERB_CACHE_MAX = 40;
let contextMenuSeq = 0;

function shellVerbKey(entry: { kind: string; ext: string }): string {
  return entry.kind === "directory" ? "dir" : `file:${entry.ext}`;
}

const shellVerbWarming = new Set<string>();

/**
 * Background warm-up: probing a kind costs a few hundred milliseconds the first
 * time (the shell loads extensions), so the menu would otherwise appear late on
 * the very first right-click of every type.
 */
function warmShellVerbs(entry: {
  path: string;
  kind: string;
  ext: string;
}): void {
  if (!isNativeShellAvailable()) return;
  const key = shellVerbKey(entry);
  if (shellVerbCache.has(key) || shellVerbWarming.has(key)) return;

  shellVerbWarming.add(key);
  void listShellVerbs(entry.path)
    .then((verbs) => rememberShellVerbs(key, verbs))
    .catch(() => undefined)
    .finally(() => shellVerbWarming.delete(key));
}

function rememberShellVerbs(key: string, verbs: ShellVerb[]): void {
  if (shellVerbCache.size >= SHELL_VERB_CACHE_MAX) {
    const oldest = shellVerbCache.keys().next().value;
    if (oldest) shellVerbCache.delete(oldest);
  }
  shellVerbCache.set(key, verbs);
}

/** Byte/time samples used to derive transfer speed. */
const taskSamples = new Map<string, { at: number; bytes: number }>();

/** Undo descriptors and destinations for in-flight tasks. */
const pendingUndo = new Map<string, UndoAction>();
const pendingTarget = new Map<string, string>();

/**
 * While a write to the system clipboard is in flight it still holds the
 * previous owner's data, so the sync has to wait for it to land.
 */
let clipboardWrites = 0;
let clipboardTouchedAt = 0;

/**
 * Task progress has its own stream: navigating reopens the directory stream,
 * and doing the same to the task stream used to lose the final "done" event of
 * a transfer that was still running.
 */
function connectTaskEvents(): void {
  if (taskSource || typeof EventSource === "undefined") return;
  const source = new EventSource(api.eventsUrl(""));
  taskSource = source;
  source.addEventListener("task", (event) => {
    try {
      const task = JSON.parse((event as MessageEvent).data) as TaskProgressDto;
      useExplorer.getState().applyTask(task);
    } catch {
      // Malformed event: ignore.
    }
  });
}

function connectEvents(watch: string): void {
  if (typeof EventSource === "undefined") return;
  connectTaskEvents();
  if (fsSource && watchedPath === watch) return;

  fsSource?.close();
  watchedPath = watch;

  const source = new EventSource(api.eventsUrl(watch));
  fsSource = source;

  source.addEventListener("fs-change", (event) => {
    let names: string[] = [];
    try {
      const payload = JSON.parse((event as MessageEvent).data) as {
        names?: unknown;
      };
      if (Array.isArray(payload.names)) {
        names = payload.names.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        );
      }
    } catch {
      // Older server without a payload: fall back to a full refresh.
    }
    watcherPendingNames.push(...names);

    if (watcherRefreshTimer) return;
    watcherRefreshTimer = setTimeout(() => {
      watcherRefreshTimer = null;
      const batch = watcherPendingNames;
      watcherPendingNames = [];
      const state = useExplorer.getState();
      if (batch.length > 0) void state.patchEntries(batch);
      else void state.refreshFromWatcher();
    }, 200);
  });
}

/**
 * Safety net for transfer tasks. SSE carries the progress, but a dropped
 * connection would otherwise leave a finished task marked "running" forever,
 * so poll while one is in flight anyway. Polling stops at the first terminal
 * status.
 */
function watchTask(taskId: string, get: GetState): void {
  let attempts = 0;

  const tick = async () => {
    const current = get().tasks[taskId];
    if (!current) return;
    if (current.status !== "running" && current.status !== "queued") return;
    if (attempts >= 300) return;
    attempts += 1;

    try {
      const latest = await api.task(taskId);
      get().applyTask(latest);
      if (latest.status !== "running" && latest.status !== "queued") return;
    } catch {
      // The task expired on the server; stop watching.
      return;
    }

    setTimeout(() => void tick(), 1200);
  };

  setTimeout(() => void tick(), 1200);
}

/** Folder sizes requested in the same tick are coalesced into one batch. */
const pendingSizePaths = new Set<string>();
const inflightSizePaths = new Set<string>();
let sizeFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSizeFlush(set: SetState, get: GetState): void {
  if (sizeFlushTimer) return;

  sizeFlushTimer = setTimeout(() => {
    sizeFlushTimer = null;

    const batch = [...pendingSizePaths].slice(0, 24);
    for (const target of batch) pendingSizePaths.delete(target);
    if (batch.length === 0) return;

    for (const target of batch) inflightSizePaths.add(target);

    void api
      .directorySizes(batch)
      .then(({ sizes }) => {
        const next = { ...get().folderSizes };
        for (const [target, value] of Object.entries(sizes)) next[target] = value;
        set({ folderSizes: next });
      })
      .catch(() => undefined)
      .finally(() => {
        for (const target of batch) inflightSizePaths.delete(target);
        if (pendingSizePaths.size > 0) scheduleSizeFlush(set, get);
      });
  }, 120);
}

export const useExplorer = create<ExplorerState>()((set, get) => ({
  route: "files",
  ready: false,
  system: null,
  drives: [],
  specials: [],

  path: "",
  parent: null,
  entries: [],
  loading: false,
  error: null,

  history: [],
  historyIndex: -1,

  selected: [],
  anchor: null,

  view: readString(PREF.view, "grid", ["grid", "list"]),
  sortKey: readString(PREF.sortKey, "name", ["name", "date", "size", "kind"]),
  sortDir: readString(PREF.sortDir, "asc", ["asc", "desc"]),
  groupKey: readString(PREF.group, "none", ["none", "name", "kind", "date", "size"]),
  appearance: readAppearance(),
  layoutEpoch: 0,
  pendingScrollTop: null,
  showHidden: readBoolean(PREF.showHidden, false),
  startLocation: readString(PREF.startLocation, "last", ["last", "home"]),
  previewOpen: readBoolean(PREF.preview, true),

  recycle: { items: [], total: 0, loading: false, skippedDrives: [] },

  query: "",
  results: null,
  searching: false,
  searchScanned: 0,
  searchTimedOut: false,
  searchTruncated: false,

  clipboard: null,
  shellIcons: {},
  folderSizes: {},
  dragging: false,
  frozenEntries: null,
  frozenPath: null,
  tasks: {},
  activeTaskId: null,
  taskSpeeds: {},
  operationsOpen: false,
  undoStack: [],
  dialog: null,
  contextMenu: null,
  contextMenuPrefs: readContextMenuPrefs(),
  shellVerbs: [],

  async init() {
    if (initStarted) return;
    initStarted = true;
    set({ loading: true, error: null });
    void pruneCachedIcons();

    try {
      const [system, specials, drives] = await Promise.all([
        api.systemInfo(),
        api.special(),
        api.drives(),
      ]);

      set({ system, specials, drives, ready: true });

      const home = specials.find((folder) => folder.id === "home")?.path ?? system.home;
      const saved = localStorage.getItem(LAST_PATH_KEY);
      const target =
        get().startLocation === "home"
          ? home
          : saved && saved.trim()
            ? saved
            : home;

      await get().navigate(target, { history: "replace" });
      if (!get().path) {
        await get().navigate(home, { history: "replace" });
      }
    } catch (error) {
      initStarted = false;
      set({
        ready: true,
        loading: false,
        error: errorMessage(error),
      });
    }
  },

  async navigate(target, options = {}) {
    const historyMode = options.history ?? "push";
    const seq = (navSeq += 1);
    closeSearchStream();
    searchSeq += 1;
    set({ loading: true, error: null, query: "", results: null, searching: false });

    try {
      const response = await api.list(target, get().showHidden);
      // A slower, older request must not overwrite the folder the user is
      // actually looking at now.
      if (seq !== navSeq) return;

      set((state) => {
        let history = state.history;
        let historyIndex = state.historyIndex;

        if (historyMode === "push") {
          history = [...state.history.slice(0, state.historyIndex + 1), response.path];
          historyIndex = history.length - 1;
        } else if (historyMode === "replace") {
          if (state.history.length === 0) {
            history = [response.path];
            historyIndex = 0;
          } else {
            history = state.history.map((item, index) =>
              index === state.historyIndex ? response.path : item,
            );
          }
        } else if (options.index !== undefined) {
          historyIndex = options.index;
        }

        localStorage.setItem(LAST_PATH_KEY, response.path);

        // Restore how this folder was left: view mode, sorting, grouping, scroll.
        const saved = folderViewFor(response.path);

        return {
          route: "files",
          path: response.path,
          parent: response.parent,
          entries: response.entries,
          loading: false,
          selected: [],
          anchor: null,
          history,
          historyIndex,
          view: saved?.view ?? state.view,
          sortKey: saved?.sortKey ?? state.sortKey,
          sortDir: saved?.sortDir ?? state.sortDir,
          groupKey: saved?.groupKey ?? state.groupKey,
          pendingScrollTop: saved?.scrollTop ?? null,
        };
      });

      void get().loadShellIcons(response.entries);
      connectEvents(response.path);

      // Warm the two menu kinds the user is most likely to right-click next.
      warmShellVerbs({ path: response.path, kind: "directory", ext: "" });
      const firstFile = response.entries.find((entry) => entry.kind === "file");
      if (firstFile) warmShellVerbs(firstFile);
    } catch (error) {
      if (seq === navSeq) set({ loading: false, error: errorMessage(error) });
    }
  },

  goBack() {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    const target = history[nextIndex];
    if (target) {
      void get().navigate(target, { history: "none", index: nextIndex });
    }
  },

  goForward() {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const nextIndex = historyIndex + 1;
    const target = history[nextIndex];
    if (target) {
      void get().navigate(target, { history: "none", index: nextIndex });
    }
  },

  goUp() {
    const { parent } = get();
    if (parent) void get().navigate(parent);
  },

  reload() {
    const { path } = get();
    if (!path) {
      initStarted = false;
      void get().init();
      return;
    }
    void get().navigate(path, { history: "none" });
  },

  setGroup(key) {
    const { path } = get();
    if (path) rememberFolderView(path, { groupKey: key });
    scheduleFolderViewsFlush();
    // Group headers need full-width rows, which only the list view has.
    const wasGrid = get().view === "grid";
    const switchView = key !== "none" && wasGrid;
    set({ groupKey: key, ...(switchView ? { view: "list" as ViewMode } : {}) });
    writePreference(PREF.group, key);
    if (switchView) {
      writePreference(PREF.view, "list");
      get().notify("已切换到列表视图以显示分组");
    }
  },

  resetLayout() {
    try {
      localStorage.removeItem("oriel:pref-sidebar-width");
      localStorage.removeItem("oriel:pref-preview-width");
      localStorage.removeItem("oriel:pref-preview");
    } catch {
      // Ignore storage failures.
    }
    set((state) => ({ layoutEpoch: state.layoutEpoch + 1, previewOpen: true }));
    writePreference(PREF.preview, true);
    get().notify("已重置布局");
  },

  rememberScrollTop(top) {
    const { path, query } = get();
    if (!path || query.trim()) return;
    rememberFolderView(path, { scrollTop: top });
    scheduleFolderViewsFlush();
  },

  forgetFolderViews() {
    resetFolderViews();
    get().notify("已清除每个文件夹的视图记忆");
  },

  setAppearance(key, value) {
    const next = { ...get().appearance, [key]: value };
    set({ appearance: next });
    writeAppearance(next);
  },

  resetAppearance() {
    set({ appearance: { ...DEFAULT_APPEARANCE } });
    writeAppearance({ ...DEFAULT_APPEARANCE });
  },

  setView(view) {
    const { path } = get();
    if (path) rememberFolderView(path, { view });
    scheduleFolderViewsFlush();
    set({ view });
    writePreference(PREF.view, view);
  },

  setSort(key) {
    const { path } = get();
    if (path) {
      const dir =
        get().sortKey === key
          ? get().sortDir === "asc"
            ? "desc"
            : "asc"
          : key === "name" || key === "kind"
            ? "asc"
            : "desc";
      rememberFolderView(path, { sortKey: key, sortDir: dir });
      scheduleFolderViewsFlush();
    }
    set((state) => {
      const sortDir =
        state.sortKey === key
          ? state.sortDir === "asc"
            ? "desc"
            : "asc"
          : key === "name" || key === "kind"
            ? "asc"
            : "desc";
      const sortKey = key;
      writePreference(PREF.sortKey, sortKey);
      writePreference(PREF.sortDir, sortDir);
      return { sortKey, sortDir };
    });
  },

  toggleHidden() {
    get().setShowHidden(!get().showHidden);
  },

  setShowHidden(value) {
    set({ showHidden: value });
    writePreference(PREF.showHidden, value);
    if (get().route === "files") get().reload();
  },

  togglePreview() {
    get().setPreviewOpen(!get().previewOpen);
  },

  setPreviewOpen(open) {
    set({ previewOpen: open });
    writePreference(PREF.preview, open);
  },

  setStartLocation(value) {
    set({ startLocation: value });
    writePreference(PREF.startLocation, value);
  },

  resetPreferences() {
    set({
      view: "grid",
      sortKey: "name",
      sortDir: "asc",
      showHidden: false,
      startLocation: "last",
      groupKey: "none",
    });
    writePreference(PREF.view, "grid");
    writePreference(PREF.group, "none");
    writePreference(PREF.sortKey, "name");
    writePreference(PREF.sortDir, "asc");
    writePreference(PREF.showHidden, false);
    writePreference(PREF.startLocation, "last");
    get().resetAppearance();
    if (get().route === "files") get().reload();
    get().notify("已恢复默认设置");
  },

  openSettings() {
    closeSearchStream();
    searchSeq += 1;
    set({
      route: "settings",
      contextMenu: null,
      dialog: null,
      query: "",
      results: null,
      searching: false,
      searchScanned: 0,
      searchTimedOut: false,
    });
  },

  closeSettings() {
    set({ route: "files" });
    const { path } = get();
    if (path) void get().navigate(path, { history: "none" });
  },

  async openRecycle() {
    closeSearchStream();
    searchSeq += 1;
    set({
      route: "recycle",
      contextMenu: null,
      dialog: null,
      query: "",
      results: null,
      searching: false,
    });
    await get().loadRecycle();
  },

  closeRecycle() {
    set({ route: "files" });
    const { path } = get();
    if (path) void get().navigate(path, { history: "none" });
  },

  async loadRecycle() {
    set((state) => ({ recycle: { ...state.recycle, loading: true } }));
    try {
      const response = await api.recycle();
      set({
        recycle: {
          items: response.items,
          total: response.total,
          loading: false,
          skippedDrives: response.skippedDrives,
        },
      });
    } catch (error) {
      set((state) => ({ recycle: { ...state.recycle, loading: false } }));
      get().notify(errorMessage(error));
    }
  },

  async restoreRecycle(ids) {
    if (ids.length === 0) return;
    try {
      const { restored, skipped } = await api.restoreRecycle(ids);
      await get().loadRecycle();
      get().notify(
        skipped.length > 0
          ? `已还原 ${restored.length} 个项目，${skipped.length} 个跳过`
          : `已还原 ${restored.length} 个项目`,
      );
      if (skipped.length > 0) {
        set({ dialog: { kind: "error", message: skipped.map((item) => item.reason).join("\n") } });
      }
      // A restored item may land in the folder the user was browsing.
      void get().refreshFromWatcher();
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  async purgeRecycle(ids) {
    if (ids.length === 0) return;
    try {
      const { purged } = await api.purgeRecycle(ids);
      await get().loadRecycle();
      get().notify(`已永久删除 ${purged} 个项目`);
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  async emptyRecycle() {
    try {
      const { purged, skipped } = await api.emptyRecycle();
      await get().loadRecycle();
      get().notify(
        skipped > 0 ? `已清空 ${purged} 个项目，${skipped} 个失败` : `已清空废纸篓（${purged} 个项目）`,
      );
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  selectOnly(path) {
    set({ selected: [path], anchor: path });
  },

  toggleSelect(path) {
    set((state) => {
      const exists = state.selected.includes(path);
      return {
        selected: exists
          ? state.selected.filter((item) => item !== path)
          : [...state.selected, path],
        anchor: exists ? state.selected[0] ?? null : path,
      };
    });
  },

  selectRange(path) {
    const state = get();
    const list = ordered(state);
    const anchorIndex = list.findIndex(
      (entry) => entry.path === (state.anchor ?? state.selected[0]),
    );
    const targetIndex = list.findIndex((entry) => entry.path === path);

    if (anchorIndex < 0 || targetIndex < 0) {
      set({ selected: [path], anchor: path });
      return;
    }

    const [from, to] =
      anchorIndex < targetIndex
        ? [anchorIndex, targetIndex]
        : [targetIndex, anchorIndex];

    set({ selected: list.slice(from, to + 1).map((entry) => entry.path) });
  },

  selectAll() {
    const list = ordered(get());
    set({
      selected: list.map((entry) => entry.path),
      anchor: list[0]?.path ?? null,
    });
  },

  clearSelection() {
    set({ selected: [], anchor: null });
  },

  moveSelection(delta) {
    const state = get();
    const list = ordered(state);
    if (list.length === 0) return;

    const current = state.selected[state.selected.length - 1];
    const index = current
      ? list.findIndex((entry) => entry.path === current)
      : -1;
    const nextIndex = Math.max(0, Math.min(list.length - 1, index + delta));
    const next = list[nextIndex];
    if (next) set({ selected: [next.path], anchor: next.path });
  },

  async extractArchive(target, mode) {
    try {
      const { archive, inner } = parseArchivePath(target);
      const platform = get().system?.platform ?? "win32";
      const parent = parentPath(archive, platform) ?? archive;
      const stem = (basename(archive).replace(/\.[^.]+$/, "") || "解压").trim();
      const separator = platform === "win32" ? "\\" : "/";
      const destination =
        mode === "here" ? parent : `${parent}${separator}${stem}`;

      await api.extractArchive(target, destination, "skip");
      get().notify(`已解压到 ${destination}`);
      if (get().path && !isArchivePath(get().path)) await get().reload();
      else void get().refreshFromWatcher();
      void inner;
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  async downloadUpdate(url, name) {
    try {
      const task = await api.downloadUpdate(url, name);
      set({
        tasks: { ...get().tasks, [task.id]: task },
        activeTaskId: task.id,
        operationsOpen: true,
      });
      watchTask(task.id, get);
      return task.id;
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
      return null;
    }
  },

  async compressSelection() {
    const { selected, path } = get();
    if (selected.length === 0) {
      get().notify("先选择要压缩的项目");
      return;
    }
    const stem = (basename(selected[0]).replace(/\.[^.]+$/, "") || "压缩文件").trim();
    try {
      const created = await api.createArchive(selected, path, `${stem}.zip`);
      await get().reload();
      set({ selected: [created.path], anchor: created.path });
      get().notify("已创建压缩包");
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  async openEntry(entry) {
    if (entry.kind === "directory") {
      await get().navigate(entry.path);
      return;
    }
    if (isBrowsableArchive(entry.ext)) {
      await get().navigate(buildArchivePath(entry.path, ""));
      return;
    }
    try {
      await api.openPath(entry.path);
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  async reveal(target) {
    try {
      await api.reveal(target);
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  setQuery(query) {
    set({ query });

    // Typing another character aborts the previous walk on the server: the
    // EventSource is the cancellation channel, not just a delivery channel.
    closeSearchStream();
    const seq = (searchSeq += 1);

    const trimmed = query.trim();
    if (!trimmed) {
      set({
        results: null,
        searching: false,
        searchTruncated: false,
        searchScanned: 0,
        searchTimedOut: false,
      });
      return;
    }

    set({ searching: true, searchTruncated: false, searchScanned: 0, searchTimedOut: false });

    searchTimer = setTimeout(() => {
      const pathAtStart = get().path;
      if (!pathAtStart) {
        set({ searching: false });
        return;
      }

      const collected: EntryDto[] = [];
      const source = new EventSource(
        api.searchStreamUrl(pathAtStart, trimmed, get().showHidden),
      );
      searchSource = source;

      let finished = false;
      const isStale = () => seq !== searchSeq || get().path !== pathAtStart;
      const stop = () => {
        source.close();
        if (searchSource === source) searchSource = null;
      };

      source.addEventListener("matches", (event) => {
        if (isStale()) return;
        try {
          const payload = JSON.parse((event as MessageEvent).data) as SearchMatchEvent;
          collected.push(...payload.entries);
          set({ results: [...collected] });
        } catch {
          // Malformed batch: the final `done` event still reports the total.
        }
      });

      source.addEventListener("progress", (event) => {
        if (isStale()) return;
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { scanned?: number };
          if (typeof payload.scanned === "number") {
            set({ searchScanned: payload.scanned });
          }
        } catch {
          // Ignore.
        }
      });

      source.addEventListener("done", (event) => {
        if (finished) return;
        finished = true;
        stop();
        if (isStale()) return;
        try {
          const payload = JSON.parse((event as MessageEvent).data) as SearchDoneEvent;
          set({
            results: [...collected],
            searching: false,
            searchTruncated: payload.truncated,
            searchTimedOut: payload.timedOut,
            searchScanned: payload.scanned,
          });
        } catch {
          set({ results: [...collected], searching: false });
        }
        void get().loadShellIcons(collected);
      });

      source.addEventListener("failed", (event) => {
        if (finished) return;
        finished = true;
        stop();
        if (isStale()) return;
        let message = "搜索失败";
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { message?: string };
          if (payload.message) message = payload.message;
        } catch {
          // Ignore.
        }
        set({ searching: false, results: [], searchTruncated: false });
        get().notify(message);
      });

      source.onerror = () => {
        // EventSource retries on its own; do not let a dead server spin forever.
        if (finished) return;
        if (source.readyState === EventSource.CLOSED) {
          finished = true;
          stop();
          if (isStale()) return;
          set({ searching: false });
          get().notify("无法连接本地文件服务，请确认 REST 服务已启动");
        }
      };
    }, 280);
  },

  copySelection(mode) {
    const { selected } = get();
    if (selected.length === 0) return;

    const paths = [...selected];
    set({ clipboard: { mode, paths } });
    get().notify(mode === "cut" ? `已剪切 ${paths.length} 个项目` : `已复制 ${paths.length} 个项目`);

    // Mirror to the real Windows clipboard so the files can be pasted into
    // other programs (QQ, Explorer, Word). The internal clipboard above keeps
    // in-app paste fast and independent of the shell.
    clipboardWrites += 1;
    clipboardTouchedAt = Date.now();
    void api
      .clipboard(paths, mode === "cut")
      .catch((error) => {
        get().notify(`写入系统剪贴板失败：${errorMessage(error)}`);
      })
      .finally(() => {
        clipboardWrites = Math.max(0, clipboardWrites - 1);
        clipboardTouchedAt = Date.now();
      });
  },

  async syncClipboard() {
    if (clipboardWrites > 0) return;
    if (Date.now() - clipboardTouchedAt < 700) return;

    let external: { paths: string[]; cut: boolean };
    try {
      external = await api.readClipboard();
    } catch {
      return;
    }

    const current = get().clipboard;
    if (external.paths.length === 0) {
      // The clipboard now holds text or nothing; Ctrl+V should do nothing.
      if (current) set({ clipboard: null });
      return;
    }

    const mode: "copy" | "cut" = external.cut ? "cut" : "copy";
    const next = { mode, paths: external.paths };
    if (clipboardEquals(get().clipboard, next)) return;
    set({ clipboard: next });
  },

  async paste() {
    const target = get().path;
    if (!target) return;
    if (isArchivePath(target)) {
      get().notify("归档内容只读，请先解压到文件夹");
      return;
    }

    // The system clipboard is the source of truth: Explorer, QQ and our own
    // Ctrl+C all write it, and the helper answers in a few milliseconds. The
    // local mirror is only trusted while one of our own writes is in flight.
    let source = get().clipboard;
    if (clipboardWrites === 0) {
      const external = await api.readClipboard().catch(() => null);
      if (external) {
        const next: ClipboardState | null =
          external.paths.length > 0
            ? { mode: external.cut ? "cut" : "copy", paths: external.paths }
            : null;
        if (!clipboardEquals(get().clipboard, next)) set({ clipboard: next });
        source = next;
      }
    }

    if (!source || source.paths.length === 0) {
      get().notify("剪贴板里没有可粘贴的项目");
      return;
    }

    const platform = get().system?.platform ?? "win32";
    const kind: TransferKind = source.mode === "copy" ? "copy" : "move";
    let sources = [...source.paths];

    // A cut pasted back into its own folder should do nothing rather than
    // silently renaming the entry to "name (1)".
    if (kind === "move") {
      sources = sources.filter(
        (item) => !samePath(parentPath(item, platform) ?? "", target, platform),
      );
      if (sources.length === 0) {
        set({ clipboard: null });
        get().notify("项目已在该文件夹中");
        return;
      }
    }

    if (source.mode === "cut") set({ clipboard: null });
    await get().startTransfer(kind, sources, target);
  },

  async dropPaths(paths, target, kind = "move") {
    if (isArchivePath(target)) {
      get().notify("归档内容只读，请先解压到文件夹");
      return;
    }
    const platform = get().system?.platform ?? "win32";
    const current = get().path;

    // Dropping something back where it already lives, or into its own subtree,
    // is a no-op that would otherwise spam the task list with failures.
    const filtered = paths.filter((item) => {
      if (samePath(item, target, platform)) return false;
      if (startsWithPath(target, item, platform)) return false;
      if (current && samePath(parentPath(item, platform) ?? "", target, platform)) {
        return false;
      }
      return true;
    });

    if (filtered.length === 0) return;
    await get().startTransfer(kind, filtered, target);
  },

  async startTransfer(kind, paths, target) {
    if (paths.length === 0) return;
    try {
      const { conflicts } = await api.conflicts(paths, target);
      if (conflicts.length > 0) {
        set({
          dialog: { kind: "conflict", action: kind, sources: paths, target, conflicts },
        });
        return;
      }
      await get().submitTransfer(kind, paths, target, "rename");
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  async submitTransfer(kind, paths, target, policy) {
    try {
      const task = await api.transfer(kind, paths, target, policy);
      set({
        activeTaskId: task.id,
        tasks: { ...get().tasks, [task.id]: task },
      });

      pendingTarget.set(task.id, target);
      watchTask(task.id, get);

      const sources = [...paths];
      pendingUndo.set(task.id, {
        label:
          kind === "move"
            ? `移动 ${sources.length} 个项目`
            : `粘贴 ${sources.length} 个项目`,
        run: async () => {
          const created = get().tasks[task.id]?.created ?? [];
          if (created.length !== sources.length) {
            throw new Error("部分项目已被修改，无法自动撤销");
          }
          if (kind === "copy") {
            await api.remove(created);
            return;
          }
          const platform = get().system?.platform ?? "win32";
          for (let index = 0; index < created.length; index += 1) {
            const parent = parentPath(sources[index] as string, platform);
            if (parent) await api.move([created[index] as string], parent);
          }
        },
      });
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  toggleOperations() {
    set({ operationsOpen: !get().operationsOpen });
  },

  async pauseTask(id) {
    try {
      await api.pauseTask(id);
    } catch (error) {
      get().notify(errorMessage(error));
    }
  },

  async resumeTask(id) {
    try {
      await api.resumeTask(id);
    } catch (error) {
      get().notify(errorMessage(error));
    }
  },

  async retryTask(id) {
    try {
      const task = await api.retryTask(id);
      set({
        tasks: { ...get().tasks, [task.id]: task },
        activeTaskId: task.id,
        operationsOpen: true,
      });
      watchTask(task.id, get);
    } catch (error) {
      get().notify(errorMessage(error));
    }
  },

  async cancelTask(id) {
    try {
      await api.cancelTask(id);
    } catch (error) {
      get().notify(errorMessage(error));
    }
  },

  clearFinishedTasks() {
    const tasks = { ...get().tasks };
    for (const [id, task] of Object.entries(tasks)) {
      if (task.status === "done" || task.status === "cancelled" || task.status === "failed") {
        delete tasks[id];
      }
    }
    set({ tasks });
  },

  applyTask(task) {
    // Speed = byte delta over time; smoothed so the number does not jump.
    const sample = taskSamples.get(task.id);
    const now = Date.now();
    const speeds = { ...get().taskSpeeds };

    if (typeof task.bytesDone === "number") {
      if (sample && now > sample.at) {
        const instant = ((task.bytesDone - sample.bytes) / (now - sample.at)) * 1000;
        if (instant >= 0 && Number.isFinite(instant)) {
          const previous = speeds[task.id] ?? instant;
          speeds[task.id] = previous * 0.6 + instant * 0.4;
        }
      }
      taskSamples.set(task.id, { at: now, bytes: task.bytesDone });
    }

    if (task.status === "done" || task.status === "failed" || task.status === "cancelled") {
      delete speeds[task.id];
      taskSamples.delete(task.id);
    }

    const tasks = { ...get().tasks, [task.id]: task };
    set({ tasks, taskSpeeds: speeds });

    if (
      task.status !== "done" &&
      task.status !== "failed" &&
      task.status !== "cancelled"
    ) {
      return;
    }

    if (get().activeTaskId === task.id) set({ activeTaskId: null });

    const undo = pendingUndo.get(task.id);
    pendingUndo.delete(task.id);
    const target = pendingTarget.get(task.id);
    pendingTarget.delete(task.id);

    if (task.status === "done") {
      if (undo) get().pushUndo(undo);
      if (target && get().path === target && task.created.length > 0) {
        set({ selected: task.created, anchor: task.created[0] ?? null });
      }
      void get().refreshFromWatcher();
      get().notify(
        task.kind === "copy"
          ? `已复制 ${task.created.length} 个项目`
          : `已移动 ${task.created.length} 个项目`,
      );
      return;
    }

    if (task.status === "failed") {
      get().notify(`操作失败：${task.error ?? "未知错误"}`);
    } else {
      get().notify("已取消操作");
    }
  },

  /**
   * Incremental watcher update: stat only the names that actually changed and
   * splice them into the existing list. A 20k-entry folder then costs a dozen
   * stats per change instead of a full re-listing.
   */
  async patchEntries(names) {
    const target = get().path;
    if (!target || names.length === 0) return;

    // A burst (unzipping, npm install) is cheaper to absorb with one listing.
    if (names.length > 400) {
      await get().refreshFromWatcher();
      return;
    }

    const platform = get().system?.platform ?? "win32";
    const keyOf = (value: string) =>
      platform === "win32" ? value.toLowerCase() : value;

    try {
      const { entries: changed } = await api.entries(target, names);
      if (get().path !== target) return;

      const showHidden = get().showHidden;
      const byName = new Map(changed.map((entry) => [keyOf(entry.name), entry]));
      const previous = get().entries;
      const touched = new Set(names.map(keyOf));
      const next: EntryDto[] = [];

      for (const entry of previous) {
        const id = keyOf(entry.name);
        if (!touched.has(id)) {
          next.push(entry);
          continue;
        }
        const update = byName.get(id);
        if (update && (showHidden || !update.hidden)) next.push(update);
      }

      const known = new Set(previous.map((entry) => keyOf(entry.name)));
      for (const entry of changed) {
        const id = keyOf(entry.name);
        if (known.has(id)) continue;
        if (!showHidden && entry.hidden) continue;
        next.push(entry);
      }

      const alive = new Set(next.map((entry) => entry.path));
      const selected = get().selected.filter((item) => alive.has(item));
      set({ entries: next, selected, anchor: selected[0] ?? null });
      void get().loadShellIcons(next);
    } catch {
      // Unknown endpoint or transient failure: fall back to a full listing.
      await get().refreshFromWatcher();
    }
  },

  /** Re-reads the current folder and patches only what actually changed. */
  async refreshFromWatcher() {
    const target = get().path;
    if (!target) return;

    try {
      const response = await api.list(target, get().showHidden);
      if (get().path !== target) return;

      const previous = new Map(get().entries.map((entry) => [entry.path, entry]));
      const next = response.entries;

      let changed = next.length !== get().entries.length;
      if (!changed) {
        for (const item of next) {
          const old = previous.get(item.path);
          if (!old || old.mtimeMs !== item.mtimeMs || old.size !== item.size) {
            changed = true;
            break;
          }
        }
      }
      if (!changed) return;

      const alive = new Set(next.map((entry) => entry.path));
      const selected = get().selected.filter((item) => alive.has(item));
      set({ entries: next, selected, anchor: selected[0] ?? null });
      void get().loadShellIcons(next);
    } catch {
      // A folder that disappeared mid-refresh is handled by the next navigation.
    }
  },

  pushUndo(action) {
    set({ undoStack: [...get().undoStack.slice(-19), action] });
  },

  async undo() {
    const stack = get().undoStack;
    const action = stack[stack.length - 1];
    if (!action) {
      get().notify("没有可撤销的操作");
      return;
    }

    set({ undoStack: stack.slice(0, -1) });

    try {
      await action.run();
      await get().refreshFromWatcher();
      get().notify(`已撤销：${action.label}`);
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  openDialog(dialog) {
    set({ dialog });
  },

  closeDialog() {
    set({ dialog: null });
  },

  async createFolder(name) {
    const { path } = get();
    if (isArchivePath(path)) {
      get().notify("归档内容只读，请先解压到文件夹");
      return false;
    }
    try {
      const created = await api.mkdir(path, name);
      await get().reload();
      set({ selected: [created.path], anchor: created.path });
      get().notify("已新建文件夹");
      return true;
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
      return false;
    }
  },

  async createFile(name, content = "") {
    const { path } = get();
    if (isArchivePath(path)) {
      get().notify("归档内容只读，请先解压到文件夹");
      return false;
    }
    try {
      const created = await api.newFile(path, name, content);
      await get().reload();
      set({ selected: [created.path], anchor: created.path });
      get().notify("已新建文件");
      return true;
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
      return false;
    }
  },

  async openTerminal() {
    const { path } = get();
    if (!path || isArchivePath(path)) {
      get().notify("归档内不能打开终端");
      return;
    }
    try {
      await api.openTerminal(path);
    } catch (error) {
      get().notify(errorMessage(error));
    }
  },

  async renameEntry(name) {
    const { dialog } = get();
    if (dialog?.kind !== "rename") return false;
    if (isArchivePath(dialog.entry.path)) {
      get().notify("归档内容只读，请先解压到文件夹");
      return false;
    }

    try {
      const previous = dialog.entry;
      const renamed = await api.rename(previous.path, name);
      await get().reload();
      set({ selected: [renamed.path], anchor: renamed.path });
      get().pushUndo({
        label: `重命名 “${previous.name}”`,
        run: async () => {
          await api.rename(renamed.path, previous.name);
        },
      });
      get().notify("已重命名");
      return true;
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
      return false;
    }
  },

  async batchRename(items) {
    if (items.length === 0) return false;

    try {
      const { renamed } = await api.batchRename(items);
      await get().reload();
      const paths = renamed.map((item) => item.to);
      set({ selected: paths, anchor: paths[0] ?? null });
      if (renamed.length > 0) {
        get().pushUndo({
          label: `批量重命名 ${renamed.length} 项`,
          run: async () => {
            await api.batchRename(
              renamed.map((item) => ({
                path: item.to,
                name: basename(item.from),
              })),
            );
          },
        });
      }
      get().notify(`已重命名 ${renamed.length} 项`);
      return true;
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
      return false;
    }
  },

  async removePaths(paths, permanent = false) {
    if (paths.length === 0) return;
    if (paths.some((item) => isArchivePath(item))) {
      get().notify("归档内容只读，请先解压到文件夹");
      return;
    }

    // Permanent deletion cannot be undone, so it always asks first.
    if (permanent) {
      set({ dialog: { kind: "confirm-remove", paths: [...paths], permanent: true } });
      return;
    }

    await get().performRemove(paths, false);
  },

  async performRemove(paths, permanent) {
    if (paths.length === 0) return;
    const state = get();
    const platform = state.system?.platform ?? "win32";
    const removingCurrent = paths.some((target) =>
      startsWithPath(state.path, target, platform),
    );

    try {
      let handled = false;
      if (isNativeShellAvailable()) {
        // The shell owns the recycle bin record, so deleting through it keeps
        // Explorer's own "还原" working for entries removed from here.
        try {
          handled = await shellDelete(paths, permanent);
        } catch {
          handled = false;
        }
      }
      if (!handled) await api.remove(paths, permanent);
      get().notify(
        permanent
          ? paths.length === 1
            ? "已永久删除 1 个项目"
            : `已永久删除 ${paths.length} 个项目`
          : paths.length === 1
            ? "已将 1 个项目移到废纸篓"
            : `已将 ${paths.length} 个项目移到废纸篓`,
      );

      if (removingCurrent) {
        const fallback =
          parentPath(state.path, platform) ??
          state.specials.find((folder) => folder.id === "home")?.path ??
          state.system?.home;
        if (fallback) await get().navigate(fallback);
      } else {
        await get().reload();
      }
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  setContextMenu(menu) {
    const seq = (contextMenuSeq += 1);

    if (!menu) {
      set({ contextMenu: null, shellVerbs: [] });
      return;
    }

    // Verbs belong to one entry; never show the previous entry's list.
    if (!menu.entry || !isNativeShellAvailable()) {
      set({ contextMenu: menu, shellVerbs: [] });
      return;
    }

    const key = shellVerbKey(menu.entry);
    const cached = shellVerbCache.get(key);
    if (cached) {
      set({ contextMenu: menu, shellVerbs: cached });
      return;
    }

    // Unknown kind: ask the shell first and open the finished menu, so the user
    // never sees the menu flip from "no shell items" to "with shell items".
    void listShellVerbs(menu.entry.path)
      .then((verbs) => {
        rememberShellVerbs(key, verbs);
        if (seq !== contextMenuSeq) return;
        set({ contextMenu: menu, shellVerbs: verbs });
      })
      .catch(() => {
        if (seq !== contextMenuSeq) return;
        set({ contextMenu: menu, shellVerbs: [] });
      });
  },

  setContextMenuPref(key, value) {
    const next = { ...get().contextMenuPrefs, [key]: value };
    set({ contextMenuPrefs: next });
    writeContextMenuPrefs(next);
  },

  toggleContextMenuItem(id) {
    const { hidden } = get().contextMenuPrefs;
    get().setContextMenuPref(
      "hidden",
      hidden.includes(id) ? hidden.filter((item) => item !== id) : [...hidden, id],
    );
  },

  toggleShellVerb(label) {
    const { hiddenVerbs } = get().contextMenuPrefs;
    get().setContextMenuPref(
      "hiddenVerbs",
      hiddenVerbs.includes(label)
        ? hiddenVerbs.filter((item) => item !== label)
        : [...hiddenVerbs, label],
    );
  },

  resetContextMenuPrefs() {
    const next = { ...readContextMenuPrefs(), hidden: [], hiddenVerbs: [] };
    set({ contextMenuPrefs: next });
    writeContextMenuPrefs(next);
    get().notify("已恢复默认右键菜单");
  },

  async loadShellVerbs(path) {
    try {
      const verbs = await listShellVerbs(path);
      // Only apply if the menu still points at the same entry.
      if (get().contextMenu?.entry?.path === path) set({ shellVerbs: verbs });
    } catch {
      set({ shellVerbs: [] });
    }
  },

  async runShellVerb(path, id) {
    try {
      await invokeShellVerb(path, id);
      await get().refreshFromWatcher();
    } catch (error) {
      set({ dialog: { kind: "error", message: errorMessage(error) } });
    }
  },

  beginDrag() {
    if (get().dragging) return;
    set({ dragging: true, frozenEntries: get().entries, frozenPath: get().path });
  },

  endDrag() {
    if (!get().dragging) return;
    set({ dragging: false, frozenEntries: null, frozenPath: null });
  },

  async loadShellIcons(entries) {
    const known = get().shellIcons;
    const pending = entries.filter(
      (entry) =>
        entry.kind === "file" &&
        (SHELL_ICON_EXTENSIONS.has(entry.ext) ||
          entry.name.toLowerCase().endsWith(".appref-ms")) &&
        !(entry.path in known),
    );

    if (pending.length === 0) return;

    // IndexedDB first: a cached icon renders on the very first paint instead of
    // popping in after a PowerShell round-trip.
    const cached = await readCachedIcons(pending.map((entry) => entry.path));
    if (cached.size > 0) {
      const next = { ...get().shellIcons };
      let changed = false;
      for (const entry of pending) {
        const hit = cached.get(entry.path);
        if (hit && Math.round(hit.mtimeMs) === Math.round(entry.mtimeMs)) {
          next[entry.path] = hit.value;
          changed = true;
        }
      }
      if (changed) set({ shellIcons: capShellIcons(next) });
    }

    const missing = pending
      .filter((entry) => {
        const hit = cached.get(entry.path);
        return !hit || Math.round(hit.mtimeMs) !== Math.round(entry.mtimeMs);
      })
      .slice(0, 120);

    if (missing.length === 0) return;

    const mtimeByPath = new Map(
      missing.map((entry) => [entry.path, entry.mtimeMs] as const),
    );

    try {
      const { icons } = await api.icons(missing.map((entry) => entry.path));
      const next = { ...get().shellIcons };
      const toCache: CachedShellIcon[] = [];
      let changed = false;

      for (const [target, value] of Object.entries(icons)) {
        if (!value) continue;
        next[target] = value;
        changed = true;
        toCache.push({
          path: target,
          mtimeMs: mtimeByPath.get(target) ?? 0,
          value,
          savedAt: Date.now(),
        });
      }

      if (changed) {
        set({ shellIcons: capShellIcons(next) });
        void writeCachedIcons(toCache);
      }
    } catch {
      // Fall back to the SF Symbol icon; the next navigation retries.
    }
  },

  notify(message) {
    toast(message, { timeout: 2200 });
  },

  requestFolderSizes(paths) {
    const { folderSizes } = get();
    for (const target of paths) {
      if (!target) continue;
      if (
        folderSizes[target] ||
        inflightSizePaths.has(target) ||
        pendingSizePaths.has(target)
      ) {
        continue;
      }
      pendingSizePaths.add(target);
    }
    if (pendingSizePaths.size > 0) scheduleSizeFlush(set, get);
  },
}));
