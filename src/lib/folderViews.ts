import type { GroupKey } from "./grouping";
import type { SortDirection, SortKey, ViewMode } from "@oriel/shared";

/**
 * Explorer-style "remember how each folder was shown": view mode, sorting,
 * grouping and scroll offset are stored per path, so returning to a folder puts
 * it back the way the user left it.
 *
 * Bounded so a long session cannot grow storage without limit.
 */

export interface FolderViewState {
  view?: ViewMode;
  sortKey?: SortKey;
  sortDir?: SortDirection;
  groupKey?: GroupKey;
  scrollTop?: number;
}

const STORAGE_KEY = "oriel:pref-folder-views";
const MAX_ENTRIES = 300;

let views: Record<string, FolderViewState> = load();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function load(): Record<string, FolderViewState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, FolderViewState>;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function key(path: string): string {
  return path.toLowerCase();
}

function trim(): void {
  const keys = Object.keys(views);
  if (keys.length <= MAX_ENTRIES) return;
  for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
    delete views[stale];
  }
}

export function rememberFolderView(path: string, patch: FolderViewState): void {
  const id = key(path);
  views[id] = { ...views[id], ...patch };
  trim();
}

export function folderViewFor(path: string): FolderViewState | null {
  return views[key(path)] ?? null;
}

export function readFolderViews(): Record<string, FolderViewState> {
  return views;
}

export function writeFolderViews(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // Storage disabled: the memory just will not persist across restarts.
  }
}

export function scheduleFolderViewsFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    writeFolderViews();
  }, 400);
}

export function resetFolderViews(): void {
  views = {};
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
