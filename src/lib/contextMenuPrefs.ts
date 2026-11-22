/**
 * Which entries the app's own context menu shows.
 *
 * The menu mixes two sources: the built-in actions and the verbs the OS offers
 * for the file (`7-Zip`, `发送到`, `使用 Defender 扫描`…). Both lists are
 * configurable because a machine with a dozen shell extensions produces a menu
 * nobody wants to read.
 */

export interface ContextMenuPrefs {
  /** Built-in item ids that are hidden. */
  hidden: string[];
  /** Merge the shell's own verbs into the app menu. */
  mergeShell: boolean;
  /** Shell verb labels that are hidden. */
  hiddenVerbs: string[];
  /** Keep the "显示更多选项…" entry that opens the real Windows menu. */
  showNativeMenu: boolean;
}

export const CONTEXT_MENU_STORAGE_KEY = "oriel:pref-context-menu";

export const DEFAULT_CONTEXT_MENU_PREFS: ContextMenuPrefs = {
  hidden: [],
  mergeShell: true,
  hiddenVerbs: [],
  showNativeMenu: true,
};

/**
 * Which menu an entry belongs to. The settings page follows the
 * 文件夹 / 文件 / 空白处 switch instead of listing the union of all menus.
 */
export type MenuScope = "entry" | "folder" | "file" | "canvas";

/** Labels for the settings page; ids must match ContextMenuLayer. */
export const BUILTIN_MENU_ITEMS: Array<{
  id: string;
  label: string;
  scope: MenuScope;
}> = [
  { id: "open", label: "打开", scope: "entry" },
  { id: "show-info", label: "显示简介", scope: "entry" },
  { id: "file-locks", label: "查看占用进程", scope: "entry" },
  { id: "properties", label: "属性…", scope: "entry" },
  { id: "copy", label: "复制", scope: "entry" },
  { id: "cut", label: "剪切", scope: "entry" },
  { id: "paste-into", label: "粘贴到此文件夹", scope: "folder" },
  { id: "copy-path", label: "复制路径", scope: "entry" },
  { id: "rename", label: "重命名", scope: "entry" },
  { id: "rename-batch", label: "批量重命名…", scope: "entry" },
  { id: "reveal", label: "在资源管理器中显示", scope: "entry" },
  { id: "trash", label: "移到废纸篓", scope: "entry" },
  { id: "delete", label: "永久删除", scope: "entry" },
  { id: "native-menu", label: "显示更多选项…", scope: "entry" },
  // Blank-area menu (right-clicking the empty part of the canvas).
  { id: "new-folder", label: "新建文件夹", scope: "canvas" },
  { id: "canvas-paste", label: "粘贴", scope: "canvas" },
  { id: "canvas-undo", label: "撤销", scope: "canvas" },
  { id: "canvas-refresh", label: "刷新", scope: "canvas" },
  { id: "canvas-hidden", label: "显示隐藏文件", scope: "canvas" },
  { id: "canvas-reveal", label: "在资源管理器中打开", scope: "canvas" },
];

export function readContextMenuPrefs(): ContextMenuPrefs {
  try {
    const raw = localStorage.getItem(CONTEXT_MENU_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONTEXT_MENU_PREFS };
    const parsed = JSON.parse(raw) as Partial<ContextMenuPrefs>;
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((item) => typeof item === "string") : [],
      mergeShell: typeof parsed.mergeShell === "boolean" ? parsed.mergeShell : true,
      hiddenVerbs: Array.isArray(parsed.hiddenVerbs)
        ? parsed.hiddenVerbs.filter((item) => typeof item === "string")
        : [],
      showNativeMenu:
        typeof parsed.showNativeMenu === "boolean" ? parsed.showNativeMenu : true,
    };
  } catch {
    return { ...DEFAULT_CONTEXT_MENU_PREFS };
  }
}

export function writeContextMenuPrefs(prefs: ContextMenuPrefs): void {
  try {
    localStorage.setItem(CONTEXT_MENU_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage disabled: preferences just will not persist.
  }
}

/** "复制文件地址(A)" → "复制文件地址" */
export function normalizeVerbLabel(label: string): string {
  return label.replace(/\([A-Za-z0-9]\)$/u, "").trim();
}

/** Verbs we already implement ourselves, so they are not listed twice. */
export const DUPLICATED_VERBS = new Set([
  "打开",
  "打开(O)",
  "剪切",
  "复制",
  "粘贴",
  "重命名",
  "删除",
  "属性",
  "复制文件地址",
]);
