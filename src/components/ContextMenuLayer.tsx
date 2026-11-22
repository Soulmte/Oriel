import { useMemo } from "react";
import { ClipboardPaste, Copy, Eye, FolderOpen, FolderPlus, Info, Link2, LockKeyhole, MonitorUp, MoreHorizontal, PackageOpen, Pencil, RefreshCw, Scissors, Settings2, Trash2, Undo2 } from "lucide-react";
import { useExplorer } from "../store/explorer";
import {
  isNativeShellAvailable,
  showShellContextMenu,
  showSystemProperties,
} from "../lib/shell";
import { isArchivePath, isBrowsableArchive } from "../lib/archivePath";
import {
  DUPLICATED_VERBS,
  normalizeVerbLabel,
} from "../lib/contextMenuPrefs";
import type { ShellVerb } from "../lib/shell";
import { basename } from "../lib/format";
import { PopupMenu, type MenuItem } from "./PopupMenu";

export function ContextMenuLayer() {
  const menu = useExplorer((state) => state.contextMenu);
  const setContextMenu = useExplorer((state) => state.setContextMenu);
  const selected = useExplorer((state) => state.selected);
  const path = useExplorer((state) => state.path);
  const clipboard = useExplorer((state) => state.clipboard);
  const showHidden = useExplorer((state) => state.showHidden);
  const undoStack = useExplorer((state) => state.undoStack);

  const openEntry = useExplorer((state) => state.openEntry);
  const openDialog = useExplorer((state) => state.openDialog);
  const copySelection = useExplorer((state) => state.copySelection);
  const startTransfer = useExplorer((state) => state.startTransfer);
  const paste = useExplorer((state) => state.paste);
  const removePaths = useExplorer((state) => state.removePaths);
  const reload = useExplorer((state) => state.reload);
  const reveal = useExplorer((state) => state.reveal);
  const toggleHidden = useExplorer((state) => state.toggleHidden);
  const notify = useExplorer((state) => state.notify);
  const undo = useExplorer((state) => state.undo);
  const extractArchiveAction = useExplorer((state) => state.extractArchive);
  const compressSelection = useExplorer((state) => state.compressSelection);
  const selectOnly = useExplorer((state) => state.selectOnly);
  const setPreviewOpen = useExplorer((state) => state.setPreviewOpen);
  const contextMenuPrefs = useExplorer((state) => state.contextMenuPrefs);
  const shellVerbs = useExplorer((state) => state.shellVerbs);
  const runShellVerb = useExplorer((state) => state.runShellVerb);

  const items = useMemo<MenuItem[]>(() => {
    if (!menu) return [];

    const copyPath = (paths: string[]) => {
      void navigator.clipboard
        .writeText(paths.join("\n"))
        .then(() => notify(paths.length > 1 ? `已复制 ${paths.length} 条路径` : "已复制路径"))
        .catch(() => notify("复制路径失败"));
    };

    const showInfo = (targets: string[]) => {
      openDialog({ kind: "properties", paths: targets });
    };

    const entry = menu.entry;
    if (!entry) {
      return [
        {
          id: "new-folder",
          label: "新建文件夹",
          icon: <FolderPlus className="size-3.5" />,
          shortcut: "Ctrl+Shift+N",
          onSelect: () => openDialog({ kind: "new-folder" }),
        },
        {
          id: "canvas-paste",
          label: "粘贴",
          icon: <ClipboardPaste className="size-3.5" />,
          shortcut: "Ctrl+V",
          disabled: !clipboard || clipboard.paths.length === 0,
          onSelect: () => void paste(),
        },
        {
          id: "canvas-undo",
          label: "撤销",
          icon: <Undo2 className="size-3.5" />,
          shortcut: "Ctrl+Z",
          disabled: undoStack.length === 0,
          onSelect: () => void undo(),
        },
        { id: "sep-1", separator: true },
        {
          id: "canvas-refresh",
          label: "刷新",
          icon: <RefreshCw className="size-3.5" />,
          shortcut: "Ctrl+R",
          onSelect: reload,
        },
        {
          id: "canvas-hidden",
          label: "显示隐藏文件",
          icon: <Eye className="size-3.5" />,
          checked: showHidden,
          onSelect: toggleHidden,
        },
        { id: "sep-2", separator: true },
        ...(selected.length > 0 && !isArchivePath(path)
          ? [
              {
                id: "canvas-compress",
                label: `压缩所选为 ZIP`,
                icon: <PackageOpen className="size-3.5" />,
                onSelect: () => void compressSelection(),
              } as MenuItem,
            ]
          : []),
        {
          id: "canvas-reveal",
          label: "在资源管理器中打开",
          icon: <MonitorUp className="size-3.5" />,
          disabled: !path,
          onSelect: () => void reveal(path),
        },
        {
          id: "canvas-info",
          label: "显示简介",
          icon: <Info className="size-3.5" />,
          shortcut: "Ctrl+I",
          disabled: !path,
          onSelect: () => showInfo([path]),
        },
      ];
    }

    const targets =
      selected.includes(entry.path) && selected.length > 1
        ? selected
        : [entry.path];

    if (targets.length > 1) {
      return [
        {
          id: "copy",
          label: `复制 ${targets.length} 个项目`,
          icon: <Copy className="size-3.5" />,
          shortcut: "Ctrl+C",
          onSelect: () => copySelection("copy"),
        },
        {
          id: "cut",
          label: `剪切 ${targets.length} 个项目`,
          icon: <Scissors className="size-3.5" />,
          shortcut: "Ctrl+X",
          onSelect: () => copySelection("cut"),
        },
        {
          id: "copy-path",
          label: "复制路径",
          icon: <Link2 className="size-3.5" />,
          onSelect: () => copyPath(targets),
        },
        {
          id: "show-info",
          label: `显示简介（${targets.length} 项）`,
          icon: <Info className="size-3.5" />,
          shortcut: "Ctrl+I",
          onSelect: () => showInfo(targets),
        },
        ...(targets.some((path) => !isArchivePath(path))
          ? [
              {
                id: "compress",
                label: `压缩为 ZIP（${targets.length} 个）`,
                icon: <PackageOpen className="size-3.5" />,
                onSelect: () => void compressSelection(),
              } as MenuItem,
            ]
          : []),
        { id: "sep-1", separator: true },
        {
          id: "trash",
          label: `将 ${targets.length} 个项目移到废纸篓`,
          icon: <Trash2 className="size-3.5" />,
          shortcut: "Delete",
          danger: true,
          onSelect: () => void removePaths(targets),
        },
      ];
    }

    const isFolder = entry.kind === "directory";
    const insideArchive = isArchivePath(entry.path);
    const isArchiveFile = entry.kind === "file" && isBrowsableArchive(entry.ext);

    const archiveItems: MenuItem[] = insideArchive
      ? [
          { id: "sep-archive", separator: true } as MenuItem,
          {
            id: "extract-here",
            label: "解压到当前文件夹",
            icon: <PackageOpen className="size-3.5" />,
            onSelect: () => void extractArchiveAction(entry.path, "here"),
          },
          {
            id: "extract-folder",
            label: "解压到同名文件夹",
            icon: <FolderPlus className="size-3.5" />,
            onSelect: () => void extractArchiveAction(entry.path, "folder"),
          },
        ]
      : isArchiveFile
        ? [
            { id: "sep-archive", separator: true } as MenuItem,
            {
              id: "extract-here-file",
              label: "解压到当前文件夹",
              icon: <PackageOpen className="size-3.5" />,
              onSelect: () => void extractArchiveAction(entry.path, "here"),
            },
            {
              id: "extract-folder-file",
              label: "解压到同名文件夹",
              icon: <FolderPlus className="size-3.5" />,
              onSelect: () => void extractArchiveAction(entry.path, "folder"),
            },
          ]
        : [];

    return [
      ...archiveItems,
      {
        id: "open",
        label: "打开",
        icon: <FolderOpen className="size-3.5" />,
        shortcut: "Enter",
        onSelect: () => void openEntry(entry),
      },
      {
        id: "show-info",
        label: "显示简介",
        icon: <Info className="size-3.5" />,
        shortcut: "Ctrl+I",
        onSelect: () => showInfo(targets),
      },
      ...(isFolder || insideArchive
        ? []
        : [
            {
              id: "file-locks",
              label: "查看占用进程",
              icon: <LockKeyhole className="size-3.5" />,
              onSelect: () => openDialog({ kind: "locks", path: entry.path }),
            } as MenuItem,
          ]),
      ...(isNativeShellAvailable()
        ? [
            {
              id: "properties",
              label: "Windows 属性…",
              icon: <Settings2 className="size-3.5" />,
              onSelect: () => {
                void showSystemProperties(entry.path).catch((error: unknown) => {
                  notify(error instanceof Error ? error.message : String(error));
                });
              },
            } as MenuItem,
          ]
        : []),
      { id: "sep-0", separator: true },
      {
        id: "copy",
        label: "复制",
        icon: <Copy className="size-3.5" />,
        shortcut: "Ctrl+C",
        onSelect: () => copySelection("copy"),
      },
      {
        id: "cut",
        label: "剪切",
        icon: <Scissors className="size-3.5" />,
        shortcut: "Ctrl+X",
        onSelect: () => copySelection("cut"),
      },
      {
        id: "copy-path",
        label: "复制路径",
        icon: <Link2 className="size-3.5" />,
        onSelect: () => copyPath(targets),
      },
      ...(isFolder && clipboard && clipboard.paths.length > 0
        ? [
            {
              id: "paste-into",
              label: "粘贴到此文件夹",
              icon: <ClipboardPaste className="size-3.5" />,
              onSelect: () =>
                void startTransfer(
                  clipboard.mode === "copy" ? "copy" : "move",
                  clipboard.paths,
                  entry.path,
                ),
            } as MenuItem,
          ]
        : []),
      // Right-clicking inside a multi-selection renames the whole selection.
      ...(selected.length > 1 && selected.includes(entry.path)
        ? [
            {
              id: "rename-batch",
              label: `批量重命名 ${selected.length} 项…`,
              icon: <Pencil className="size-3.5" />,
              shortcut: "F2",
              disabled: selected.some((item) => isArchivePath(item)),
              onSelect: () => openDialog({ kind: "batch-rename", paths: [...selected] }),
            } as MenuItem,
          ]
        : [
            {
              id: "rename",
              label: "重命名",
              icon: <Pencil className="size-3.5" />,
              shortcut: "F2",
              onSelect: () => openDialog({ kind: "rename", entry }),
            } as MenuItem,
          ]),
      { id: "sep-2", separator: true },
      {
        id: "reveal",
        label: `在资源管理器中显示 “${basename(entry.name) || entry.name}”`,
        icon: <MonitorUp className="size-3.5" />,
        onSelect: () => void reveal(entry.path),
      },
      { id: "sep-3", separator: true },
      {
        id: "trash",
        label: "移到废纸篓",
        icon: <Trash2 className="size-3.5" />,
        shortcut: "Delete",
        danger: true,
        onSelect: () => void removePaths(targets),
      },
      {
        id: "delete",
        label: "永久删除",
        icon: <Trash2 className="size-3.5" />,
        shortcut: "Shift+Delete",
        danger: true,
        onSelect: () => void removePaths(targets, true),
      },
      ...(isNativeShellAvailable()
        ? [
            { id: "sep-native", separator: true } as MenuItem,
            {
              id: "native-menu",
              label: "显示更多选项…",
              icon: <MoreHorizontal className="size-3.5" />,
              onSelect: () => {
                setContextMenu(null);
                void showShellContextMenu(entry.path)
                  .catch((error: unknown) => {
                    notify(error instanceof Error ? error.message : String(error));
                  })
                  .finally(() => void reload());
              },
            } as MenuItem,
          ]
        : []),
    ];
  }, [
    menu,
    selected,
    path,
    clipboard,
    showHidden,
    undoStack,
    openDialog,
    openEntry,
    paste,
    removePaths,
    reload,
    reveal,
    copySelection,
    toggleHidden,
    notify,
    undo,
    selectOnly,
    setPreviewOpen,
    startTransfer,
  ]);

  if (!menu) return null;

  const prefs = contextMenuPrefs;
  const visible = items.filter((item) => {
    if (item.separator) return true;
    if (item.id === "native-menu") return prefs.showNativeMenu;
    return !prefs.hidden.includes(item.id);
  });

  // Hide separators that end up leading, trailing or doubled.
  const cleaned = visible.filter(
    (item, index) =>
      !(item.separator && (index === 0 || visible[index - 1]?.separator)),
  );
  while (cleaned.length > 0 && cleaned[cleaned.length - 1]?.separator) {
    cleaned.pop();
  }

  const shellItems: MenuItem[] =
    prefs.mergeShell && isNativeShellAvailable() && menu.entry
      ? (() => {
          const path = menu.entry!.path;
          const seen = new Set<string>();

          const toItem = (verb: ShellVerb, index: number, prefix: string): MenuItem => {
            const label = normalizeVerbLabel(verb.label);
            const id = `${prefix}-${index}-${verb.id}`;
            const children = (verb.children ?? [])
              .filter((child) => !prefs.hiddenVerbs.includes(normalizeVerbLabel(child.label)))
              .map((child, childIndex) => toItem(child, childIndex, id));

            if (children.length > 0) {
              return { id, label, children };
            }

            return {
              id,
              label,
              onSelect: () => {
                setContextMenu(null);
                void runShellVerb(path, verb.id);
              },
            };
          };

          return shellVerbs
            .filter((verb) => !DUPLICATED_VERBS.has(normalizeVerbLabel(verb.label)))
            .filter((verb) => !prefs.hiddenVerbs.includes(verb.label))
            .filter((verb) => {
              const key = normalizeVerbLabel(verb.label);
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
            .map((verb, index) => toItem(verb, index, "shell"));
        })()
      : [];

  const finalItems: MenuItem[] =
    shellItems.length > 0
      ? [
          ...cleaned,
          { id: "sep-shell", separator: true } as MenuItem,
          ...shellItems,
        ]
      : cleaned;

  return (
    <PopupMenu
      x={menu.x}
      y={menu.y}
      items={finalItems}
      minWidth={230}
      onClose={() => setContextMenu(null)}
    />
  );
}
