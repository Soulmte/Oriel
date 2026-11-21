import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import {
  ClipboardPaste,
  Copy,
  Eye,
  FolderOpen,
  FolderPlus,
  Info,
  Link2,
  MonitorUp,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Scissors,
  Settings2,
  Trash2,
  Undo2,
} from "lucide-react";
import type { MenuItem } from "../PopupMenu";
import { MENU_SURFACE_CLASS, MenuPreview } from "../PopupMenu";
import { useExplorer } from "../../store/explorer";
import { api } from "../../lib/api";
import {
  BUILTIN_MENU_ITEMS,
  DUPLICATED_VERBS,
  normalizeVerbLabel,
} from "../../lib/contextMenuPrefs";
import { isNativeShellAvailable, listShellVerbs } from "../../lib/shell";
import type { ShellVerb } from "../../lib/shell";
import {
  SEGMENT_CLASS,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "./shared";

const SHORTCUTS: Record<string, string> = {
  open: "Enter",
  copy: "Ctrl+C",
  cut: "Ctrl+X",
  rename: "F2",
  trash: "Delete",
  delete: "Shift+Delete",
  "new-folder": "Ctrl+Shift+N",
  "canvas-paste": "Ctrl+V",
  "canvas-undo": "Ctrl+Z",
  "canvas-refresh": "Ctrl+R",
};

/** Extensions that make poor samples (they barely add any shell verbs). */
const POOR_SAMPLE_EXTENSIONS = new Set(["ini", "lnk", "url", "tmp"]);

/** Same glyphs the real menu uses, so the preview is not a look-alike. */
const MENU_ICONS: Record<string, ReactNode> = {
  open: <FolderOpen className="size-3.5" />,
  "show-info": <Info className="size-3.5" />,
  properties: <Settings2 className="size-3.5" />,
  copy: <Copy className="size-3.5" />,
  cut: <Scissors className="size-3.5" />,
  "paste-into": <ClipboardPaste className="size-3.5" />,
  "copy-path": <Link2 className="size-3.5" />,
  rename: <Pencil className="size-3.5" />,
  reveal: <MonitorUp className="size-3.5" />,
  trash: <Trash2 className="size-3.5" />,
  delete: <Trash2 className="size-3.5" />,
  "native-menu": <MoreHorizontal className="size-3.5" />,
  "new-folder": <FolderPlus className="size-3.5" />,
  "canvas-paste": <ClipboardPaste className="size-3.5" />,
  "canvas-undo": <Undo2 className="size-3.5" />,
  "canvas-refresh": <RefreshCw className="size-3.5" />,
  "canvas-hidden": <Eye className="size-3.5" />,
  "canvas-reveal": <MonitorUp className="size-3.5" />,
};

type Mode = "folder" | "file" | "canvas";

const MODE_LABEL: Record<Mode, string> = {
  folder: "文件夹",
  file: "文件",
  canvas: "空白处",
};

function separator(id: string): MenuItem {
  return { id, separator: true };
}

/** Drops leading, trailing and doubled separators. */
function tidy(items: MenuItem[]): MenuItem[] {
  const kept = items.filter(
    (item, index) => !(item.separator && (index === 0 || items[index - 1]?.separator)),
  );
  while (kept.length > 0 && kept[kept.length - 1]?.separator) kept.pop();
  return kept;
}

export function SettingsContextMenu() {
  const prefs = useExplorer((state) => state.contextMenuPrefs);
  const setContextMenuPref = useExplorer((state) => state.setContextMenuPref);
  const toggleContextMenuItem = useExplorer((state) => state.toggleContextMenuItem);
  const toggleShellVerb = useExplorer((state) => state.toggleShellVerb);
  const resetContextMenuPrefs = useExplorer((state) => state.resetContextMenuPrefs);
  const home = useExplorer((state) => state.system?.home ?? "");
  const specials = useExplorer((state) => state.specials);

  const nativeShell = isNativeShellAvailable();
  const [mode, setMode] = useState<Mode>("folder");
  const showHidden = useExplorer((state) => state.showHidden);
  const [verbs, setVerbs] = useState<{ folder: ShellVerb[]; file: ShellVerb[] }>({
    folder: [],
    file: [],
  });
  const [samples, setSamples] = useState<{
    folder: { name: string; path: string } | null;
    file: { name: string; path: string } | null;
  }>({ folder: null, file: null });

  // Probe one folder and one real file so each mode shows its own menu, not a
  // union: a folder has 粘贴到此文件夹 / 批量压缩, a .html file has 打开方式…
  useEffect(() => {
    if (!nativeShell || !home) return;
    let alive = true;

    void (async () => {
      const folderVerbs = await listShellVerbs(home).catch(() => [] as ShellVerb[]);
      const folderSample = {
        path: home,
        name: home.split(/[\\/]/).filter(Boolean).pop() ?? home,
      };

      let fileSample: { name: string; path: string } | null = null;
      const directories = [
        home,
        ...specials.filter((folder) => folder.id !== "home").map((folder) => folder.path),
      ];

      for (const directory of directories) {
        const listing = await api.list(directory, false).catch(() => null);
        const entry = listing?.entries.find(
          (item) =>
            item.kind === "file" && !POOR_SAMPLE_EXTENSIONS.has(item.ext),
        );
        if (entry) {
          fileSample = { name: entry.name, path: entry.path };
          break;
        }
      }

      const fileVerbs = fileSample
        ? await listShellVerbs(fileSample.path).catch(() => [] as ShellVerb[])
        : [];

      if (!alive) return;
      setSamples({ folder: folderSample, file: fileSample });
      setVerbs({ folder: folderVerbs, file: fileVerbs });
    })();

    return () => {
      alive = false;
    };
  }, [nativeShell, home, specials]);

  const sample = mode === "canvas" ? null : samples[mode];

  /** Verbs for the mode currently shown on the right. */
  const verbLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const verb of (mode === "canvas" ? [] : verbs[mode]) ?? []) {
      const label = normalizeVerbLabel(verb.label);
      if (DUPLICATED_VERBS.has(label)) continue;
      labels.add(label);
    }
    return [...labels];
  }, [verbs, mode]);

  /** Built-in entries that actually exist in this mode's menu. */
  const applicableItems = useMemo(
    () =>
      BUILTIN_MENU_ITEMS.filter((item) =>
        mode === "canvas"
          ? item.scope === "canvas"
          : item.scope === "entry" || item.scope === mode,
      ),
    [mode],
  );

  const previewItems = useMemo<MenuItem[]>(() => {
    const items: MenuItem[] = [];

    const push = (id: string, label: string, extra?: Partial<MenuItem>) => {
      if (prefs.hidden.includes(id)) return;
      items.push({ id, label, icon: MENU_ICONS[id], shortcut: SHORTCUTS[id], ...extra });
    };

    if (mode === "canvas") {
      push("new-folder", "新建文件夹");
      push("canvas-paste", "粘贴");
      push("canvas-undo", "撤销");
      items.push(separator("sep-canvas-1"));
      push("canvas-refresh", "刷新");
      push("canvas-hidden", "显示隐藏文件", { checked: showHidden });
      items.push(separator("sep-canvas-2"));
      push("canvas-reveal", "在资源管理器中打开");
      return tidy(items);
    }

    const isFolder = mode === "folder";

    push("open", "打开");
    push("show-info", "显示简介");
    if (nativeShell) push("properties", "属性…");
    items.push(separator("sep-0"));
    push("copy", "复制");
    push("cut", "剪切");
    if (isFolder) push("paste-into", "粘贴到此文件夹");
    push("copy-path", "复制路径");
    push("rename", "重命名");
    items.push(separator("sep-1"));
    push("reveal", "在资源管理器中显示");
    items.push(separator("sep-2"));
    push("trash", "移到废纸篓", { danger: true });
    push("delete", "永久删除", { danger: true });
    if (nativeShell && prefs.showNativeMenu) {
      items.push(separator("sep-3"));
      push("native-menu", "显示更多选项…");
    }

    if (prefs.mergeShell && nativeShell) {
      const seen = new Set<string>();

      const toItem = (verb: ShellVerb, index: number): MenuItem => {
        const label = normalizeVerbLabel(verb.label);
        const children = (verb.children ?? [])
          .filter((child) => !prefs.hiddenVerbs.includes(normalizeVerbLabel(child.label)))
          .map((child, childIndex) => toItem(child, childIndex));
        return children.length > 0
          ? { id: `shell-${index}-${verb.id}`, label, children }
          : { id: `shell-${index}-${verb.id}`, label };
      };

      const shellItems = (verbs[mode] ?? [])
        .filter((verb) => !DUPLICATED_VERBS.has(normalizeVerbLabel(verb.label)))
        .filter((verb) => !prefs.hiddenVerbs.includes(normalizeVerbLabel(verb.label)))
        .filter((verb) => {
          const key = normalizeVerbLabel(verb.label);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map((verb, index) => toItem(verb, index));

      if (shellItems.length > 0) {
        items.push(separator("sep-shell"));
        items.push(...shellItems);
      }
    }

    return tidy(items);
  }, [mode, nativeShell, prefs, verbs, showHidden]);

  return (
    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div>
        <SettingsPageHeader
          title="右键菜单"
          detail={`左右两侧都跟随「${MODE_LABEL[mode]}」：左边只列出该菜单里的项目，右边是它的实际样子`}
        />

        {mode !== "canvas" && (
        <SettingsSection title="合并">
          <SettingsRow
            title="合并系统操作"
            detail="把系统菜单里的项目（7-Zip、发送到、扫描、网盘…）放进应用自己的右键菜单"
          >
            <SettingsSwitch
              label="合并系统操作"
              selected={prefs.mergeShell}
              disabled={!nativeShell}
              onChange={(value) => setContextMenuPref("mergeShell", value)}
            />
          </SettingsRow>
          <SettingsRow
            title="保留「显示更多选项…」"
            detail="需要完整 Windows 菜单（含子菜单）时使用，桌面版可用"
          >
            <SettingsSwitch
              label="保留显示更多选项"
              selected={prefs.showNativeMenu}
              disabled={!nativeShell}
              onChange={(value) => setContextMenuPref("showNativeMenu", value)}
            />
          </SettingsRow>
        </SettingsSection>
        )}

        {mode === "canvas" && (
          <p className="mt-6 rounded-[8px] bg-black/[0.035] px-3 py-2 text-[12px] leading-5 text-mac-muted dark:bg-white/[0.05]">
            空白处菜单只有应用自己的命令，没有系统扩展项；系统菜单跟着选中的文件/文件夹走。
          </p>
        )}

        <SettingsSection
          title={`应用菜单项 · ${MODE_LABEL[mode]}（${applicableItems.length}）`}
        >
          <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
            {applicableItems.map((item) => {
              const visible = !prefs.hidden.includes(item.id);
              return (
                <label
                  key={item.id}
                  className="flex min-h-[34px] items-center justify-between gap-3 border-b border-mac-line/60 py-1 text-[12.5px]"
                >
                  <span className={visible ? "text-mac-text" : "text-mac-muted/70"}>
                    {item.label}
                  </span>
                  <SettingsSwitch
                    label={item.label}
                    selected={visible}
                    onChange={() => toggleContextMenuItem(item.id)}
                  />
                </label>
              );
            })}
          </div>
        </SettingsSection>

        {nativeShell && mode !== "canvas" && (
          <SettingsSection
            title={`系统菜单项 · ${MODE_LABEL[mode]}（${verbLabels.length}）`}
          >
            <p className="py-2 text-[12px] leading-5 text-mac-muted">
              {sample
                ? `探测自 ${sample.path}，关掉的项不会出现在右键菜单里`
                : "没有可用于探测的样本，切到另一种模式试试"}
            </p>
            {verbLabels.length === 0 ? (
              <p className="pb-3 text-[12px] text-mac-muted/70">未检测到额外的系统菜单项</p>
            ) : (
              <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
                {verbLabels.map((label) => {
                  const visible = !prefs.hiddenVerbs.includes(label);
                  return (
                    <label
                      key={label}
                      className="flex min-h-[34px] items-center justify-between gap-3 border-b border-mac-line/60 py-1 text-[12.5px]"
                    >
                      <span className={visible ? "text-mac-text" : "text-mac-muted/70"}>
                        {label}
                      </span>
                      <SettingsSwitch
                        label={label}
                        selected={visible}
                        onChange={() => toggleShellVerb(label)}
                      />
                    </label>
                  );
                })}
              </div>
            )}
            <div className="flex justify-end py-2">
              <button
                type="button"
                onClick={resetContextMenuPrefs}
                className="text-[11.5px] text-mac-muted transition-colors hover:text-mac-text"
              >
                全部恢复显示
              </button>
            </div>
          </SettingsSection>
        )}
      </div>

      <aside className="sticky top-0">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-mac-muted">预览</span>
          <span className="flex-1" />
          <ToggleButtonGroup
            aria-label="预览对象"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[mode]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (next === "folder" || next === "file" || next === "canvas") setMode(next);
            }}
            size="sm"
            className="rounded-lg border border-mac-line bg-mac-chrome p-0.5"
          >
            <ToggleButton id="folder" className={SEGMENT_CLASS}>
              文件夹
            </ToggleButton>
            <ToggleButton id="file" className={SEGMENT_CLASS}>
              文件
            </ToggleButton>
            <ToggleButton id="canvas" className={SEGMENT_CLASS}>
              空白处
            </ToggleButton>
          </ToggleButtonGroup>
        </div>

        <div className="mt-2">
          <div className="mb-1.5 flex items-center gap-2 text-[11px] text-mac-muted">
            <span className="truncate" title={sample?.path}>
              {mode === "canvas"
                ? "画布空白处"
                : sample?.name ?? (mode === "folder" ? "示例文件夹" : "示例文件")}
            </span>
            <span className="ml-auto shrink-0 tabular-nums">
              {previewItems.length} 项
            </span>
          </div>
          {previewItems.length === 0 ? (
            <div className={`${MENU_SURFACE_CLASS} px-2 py-3 text-[12px] text-mac-muted`}>
              当前设置下没有任何菜单项
            </div>
          ) : (
            <MenuPreview items={previewItems} label="右键菜单预览" />
          )}
          <p className="mt-2 text-[11px] leading-5 text-mac-muted/70">
            只是预览，点击不会执行。切换上方按钮后，左侧可配置项与这份预览会一起换成该模式的菜单。
          </p>
        </div>
      </aside>
    </div>
  );
}
