import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import type {
  EntryDto,
  SortDirection,
  SortKey,
  ViewMode,
} from "@oriel/shared";
import { Spinner } from "@heroui/react";
import { clsx } from "clsx";
import {
  SFArrowClockwise,
  SFArrowDown,
  SFArrowUp,
  SFArrowUpRightSquare,
  SFChevronLeft,
  SFChevronRight,
  SFChevronDown,
  SFChevronUp,
  SFFolderFill,
  SFListBullet,
  SFSquareGrid2x2,
} from "sf-symbols-lib/dualtone";
import { FileIcon } from "../../lib/fileIcons";
import { api, errorMessage } from "../../lib/api";
import {
  basename,
  displayName,
  formatBytes,
  parentPath,
  samePath,
  sortEntries,
  startsWithPath,
} from "../../lib/format";
import { dragKind, getDraggedPaths, setDragPayload } from "../../lib/dnd";
import { useDropTarget } from "../../hooks/useDropTarget";
import { useDoubleClickOpen } from "../../hooks/useDoubleClickOpen";
import { SHELL_ICON_EXTENSIONS, useExplorer } from "../../store/explorer";
import { paneBridge } from "../../lib/paneBridge";
import { PopupMenu } from "../PopupMenu";
import type { MenuItem } from "../PopupMenu";

export interface PaneMemory {
  path?: string;
  view: ViewMode;
  sortKey: SortKey;
  sortDir: SortDirection;
}

/** Session-only memory so switching 2 → 4 → 2 keeps each pane's folder. */
export const paneMemory: PaneMemory[] = [];

interface ListingState {
  path: string;
  parent: string | null;
  entries: EntryDto[];
  loading: boolean;
  error: string | null;
  history: string[];
  historyIndex: number;
  selected: string[];
  anchor: string | null;
}

const THUMBNAIL_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "avif",
]);

const SORT_CHOICES: Array<{ value: SortKey; label: string }> = [
  { value: "name", label: "名称" },
  { value: "date", label: "日期" },
  { value: "size", label: "大小" },
  { value: "kind", label: "种类" },
];

const SORT_LABEL = Object.fromEntries(
  SORT_CHOICES.map((choice) => [choice.value, choice.label]),
) as Record<SortKey, string>;

function PaneButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-5 shrink-0 place-items-center rounded-[4px] text-mac-muted transition-colors hover:bg-black/[0.07] hover:text-mac-text disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-white/10"
    >
      {children}
    </button>
  );
}

function PaneTile({
  entry,
  index,
  view,
  selected,
  shellIcon,
  thumbnailUrl,
  showExtensions,
  onActivate,
  onSelect,
  onOpen,
  onMenu,
  onDragStart,
  onDropInto,
  onHoverFolder,
}: {
  entry: EntryDto;
  index: number;
  view: ViewMode;
  selected: boolean;
  shellIcon?: string;
  thumbnailUrl?: string;
  showExtensions: boolean;
  onActivate: () => void;
  onSelect: (event: ReactMouseEvent, entry: EntryDto) => void;
  onOpen: (entry: EntryDto) => void;
  onMenu: (event: ReactMouseEvent, entry: EntryDto) => void;
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>, entry: EntryDto) => void;
  onDropInto: (
    entry: EntryDto,
    paths: string[],
    kind: "copy" | "move",
  ) => void;
  onHoverFolder: (entry: EntryDto) => void;
}) {
  const drop = useDropTarget({
    enabled: entry.kind === "directory",
    hoverDelay: 600,
    onDrop: (paths, event) => onDropInto(entry, paths, dragKind(event)),
    onHover: () => onHoverFolder(entry),
  });
  const openOnClick = useDoubleClickOpen(() => onOpen(entry));

  const label = displayName(entry, showExtensions);
  const icon = (
    <FileIcon
      entry={entry}
      size={view === "grid" ? 40 : 16}
      shellIcon={shellIcon}
      thumbnailUrl={thumbnailUrl}
    />
  );

  if (view === "list") {
    return (
      <button
        type="button"
        data-pane-index={index}
        draggable
        {...drop.dropProps}
        onClick={(event) => {
          onActivate();
          onSelect(event, entry);
          openOnClick(entry.path, event);
        }}
        onContextMenu={(event) => onMenu(event, entry)}
        onDragStart={(event) => onDragStart(event, entry)}
        title={entry.path}
        className={clsx(
          "flex h-7 w-full touch-manipulation items-center gap-2 rounded-[5px] px-2 text-left text-[12px] outline-none",
          "transition-colors focus-visible:ring-2 focus-visible:ring-mac-blue/50",
          drop.active
            ? "bg-mac-blue/20 ring-1 ring-inset ring-mac-blue"
            : selected
              ? "bg-mac-blue text-white"
              : "hover:bg-black/[0.045] dark:hover:bg-white/[0.06]",
        )}
      >
        <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span
          className={clsx(
            "w-14 shrink-0 text-right text-[10.5px] tabular-nums",
            selected ? "text-white/75" : "text-mac-muted",
          )}
        >
          {entry.kind === "directory" ? "—" : formatBytes(entry.size)}
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-pane-index={index}
      draggable
      {...drop.dropProps}
      onClick={(event) => {
        onActivate();
        onSelect(event, entry);
        openOnClick(entry.path, event);
      }}
      onContextMenu={(event) => onMenu(event, entry)}
      onDragStart={(event) => onDragStart(event, entry)}
      title={entry.path}
      className={clsx(
        "flex h-[88px] touch-manipulation flex-col items-center gap-1 rounded-[7px] px-1 py-1.5 text-center outline-none",
        "transition-colors focus-visible:ring-2 focus-visible:ring-mac-blue/50",
        drop.active
          ? "bg-mac-blue/20 ring-1 ring-inset ring-mac-blue"
          : selected
            ? "bg-mac-blue"
            : "hover:bg-black/[0.045] dark:hover:bg-white/[0.06]",
      )}
    >
      <span className="grid h-10 place-items-center">{icon}</span>
      <span
        className={clsx(
          "line-clamp-2 w-full break-words text-[11px] leading-[14px]",
          selected ? "text-white" : "text-mac-text",
        )}
      >
        {label}
      </span>
    </button>
  );
}

export function Pane({
  index,
  initialPath,
  active,
  onActivate,
  onExit,
}: {
  index: number;
  initialPath: string;
  active: boolean;
  onActivate: () => void;
  onExit: (path: string) => void;
}) {
  const notify = useExplorer((state) => state.notify);
  const showHidden = useExplorer((state) => state.showHidden);
  const showExtensions = useExplorer((state) => state.appearance.showExtensions);
  const platform = useExplorer((state) => state.system?.platform ?? "win32");

  const storeSnapshot = useExplorer.getState();
  if (!paneMemory[index]) {
    paneMemory[index] = {
      view: storeSnapshot.view,
      sortKey: storeSnapshot.sortKey,
      sortDir: storeSnapshot.sortDir,
    };
  }
  const memory = paneMemory[index];

  const [listing, setListing] = useState<ListingState>(() => ({
    path: initialPath,
    parent: null,
    entries: [],
    loading: true,
    error: null,
    history: [],
    historyIndex: -1,
    selected: [],
    anchor: null,
  }));
  const [view, setView] = useState<ViewMode>(memory.view);
  const [sortKey, setSortKey] = useState<SortKey>(memory.sortKey);
  const [sortDir, setSortDir] = useState<SortDirection>(memory.sortDir);
  const [shellIcons, setShellIcons] = useState<Record<string, string>>({});
  const [address, setAddress] = useState(initialPath);
  const [renaming, setRenaming] = useState<{ entry: EntryDto; value: string } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<{
    paths: string[];
    permanent: boolean;
  } | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    entry?: EntryDto;
  } | null>(null);
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef(initialPath);
  const historyIndexRef = useRef(-1);
  const seqRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  const loadIcons = useCallback(async (entries: EntryDto[], token: number) => {
    const wanted = entries
      .filter(
        (entry) =>
          entry.kind === "file" &&
          (SHELL_ICON_EXTENSIONS.has(entry.ext) ||
            entry.name.toLowerCase().endsWith(".appref-ms")),
      )
      .slice(0, 120);
    if (wanted.length === 0) return;

    try {
      const { icons } = await api.icons(wanted.map((entry) => entry.path));
      if (token !== seqRef.current) return;
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(icons)) {
        if (value) next[key] = value;
      }
      if (Object.keys(next).length > 0) {
        setShellIcons((previous) => ({ ...previous, ...next }));
      }
    } catch {
      // Built-in file icons remain a good fallback.
    }
  }, []);

  const navigate = useCallback(
    async (
      target: string,
      mode: "push" | "replace" | "none" = "push",
      historyIndex?: number,
    ) => {
      if (!target) return;
      const token = ++seqRef.current;
      setListing((previous) => ({ ...previous, loading: true, error: null }));

      try {
        const response = await api.list(target, useExplorer.getState().showHidden);
        if (token !== seqRef.current) return;

        setListing((previous) => {
          let history = previous.history;
          let nextIndex = previous.historyIndex;
          if (mode === "push") {
            history = [
              ...previous.history.slice(0, previous.historyIndex + 1),
              response.path,
            ];
            nextIndex = history.length - 1;
          } else if (mode === "replace") {
            if (history.length === 0) {
              history = [response.path];
              nextIndex = 0;
            } else {
              history = history.map((item, position) =>
                position === previous.historyIndex ? response.path : item,
              );
            }
          } else if (historyIndex !== undefined) {
            nextIndex = historyIndex;
          }
          historyIndexRef.current = nextIndex;
          return {
            path: response.path,
            parent: response.parent,
            entries: response.entries,
            loading: false,
            error: null,
            history,
            historyIndex: nextIndex,
            selected: [],
            anchor: null,
          };
        });

        pathRef.current = response.path;
        memory.path = response.path;
        setAddress(response.path);
        if (activeRef.current) {
          useExplorer.setState({ paneActivePath: response.path });
        }
        void loadIcons(response.entries, token);
      } catch (error) {
        if (token !== seqRef.current) return;
        setListing((previous) => ({
          ...previous,
          loading: false,
          error: errorMessage(error),
        }));
      }
    },
    [loadIcons, memory],
  );

  const refresh = useCallback(() => {
    if (pathRef.current) {
      void navigate(pathRef.current, "none", historyIndexRef.current);
    }
  }, [navigate]);

  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const paneApiRef = useRef({
    path: () => pathRef.current,
    navigate: (target: string) => void navigateRef.current(target, "push"),
    refresh: () => void refreshRef.current(),
  });

  useEffect(() => {
    if (initialPath) void navigate(initialPath, "replace");
    // The pane owns its folder for its whole lifetime; layout changes pass a
    // new initialPath but must not reset a pane the user already navigated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (active) {
      paneBridge.active = paneApiRef.current;
      if (pathRef.current) {
        useExplorer.setState({ paneActivePath: pathRef.current });
      }
    } else if (paneBridge.active === paneApiRef.current) {
      paneBridge.active = null;
    }
    // `listing.path` keeps the bridge pointing at the latest API object.
  }, [active, listing.path]);

  useEffect(() => {
    return () => {
      if (paneBridge.active === paneApiRef.current) paneBridge.active = null;
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      if (pathRef.current) {
        void navigateRef.current(pathRef.current, "none", historyIndexRef.current);
      }
    };
    window.addEventListener("oriel:panes-refresh", handler);
    return () => window.removeEventListener("oriel:panes-refresh", handler);
  }, []);

  const hiddenRef = useRef(showHidden);
  useEffect(() => {
    if (hiddenRef.current === showHidden) return;
    hiddenRef.current = showHidden;
    refresh();
  }, [showHidden, refresh]);

  const sorted = useMemo(
    () => sortEntries(listing.entries, sortKey, sortDir),
    [listing.entries, sortKey, sortDir],
  );

  const selectOnly = (target: string) => {
    setListing((previous) => ({
      ...previous,
      selected: [target],
      anchor: target,
    }));
  };

  const toggleSelect = (target: string) => {
    setListing((previous) => {
      const selected = previous.selected.includes(target)
        ? previous.selected.filter((item) => item !== target)
        : [...previous.selected, target];
      return { ...previous, selected, anchor: target };
    });
  };

  const selectRange = (target: string) => {
    setListing((previous) => {
      const anchor = previous.anchor ?? target;
      const start = sorted.findIndex((entry) => entry.path === anchor);
      const end = sorted.findIndex((entry) => entry.path === target);
      if (start < 0 || end < 0) {
        return { ...previous, selected: [target], anchor: target };
      }
      const [from, to] = start < end ? [start, end] : [end, start];
      return {
        ...previous,
        selected: sorted.slice(from, to + 1).map((entry) => entry.path),
        anchor,
      };
    });
  };

  const clearSelection = () => {
    setListing((previous) => ({ ...previous, selected: [], anchor: null }));
  };

  const selectAll = () => {
    setListing((previous) => ({
      ...previous,
      selected: sorted.map((entry) => entry.path),
      anchor: sorted[0]?.path ?? null,
    }));
  };

  const moveSelection = (delta: number) => {
    if (sorted.length === 0) return;
    const current = listing.selected[0];
    const indexNow = current
      ? sorted.findIndex((entry) => entry.path === current)
      : -1;
    const next = Math.min(sorted.length - 1, Math.max(0, indexNow + delta));
    const entry = sorted[next];
    if (!entry) return;
    selectOnly(entry.path);
    requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-pane-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  const openEntry = (entry: EntryDto) => {
    if (entry.kind === "directory") {
      void navigate(entry.path, "push");
      return;
    }
    void api.openPath(entry.path).catch((error) => notify(errorMessage(error)));
  };

  const openSelected = () => {
    const entry = sorted.find((item) => item.path === listing.selected[0]);
    if (entry) openEntry(entry);
  };

  const scheduleRefresh = () => {
    for (const delay of [600, 1600]) {
      window.setTimeout(() => {
        window.dispatchEvent(new Event("oriel:panes-refresh"));
      }, delay);
    }
  };

  const transferInto = (
    paths: string[],
    target: string,
    kind: "copy" | "move",
  ) => {
    if (paths.length === 0) return;
    const invalid = paths.some(
      (item) =>
        samePath(item, target, platform) || startsWithPath(target, item, platform),
    );
    if (invalid) {
      notify("不能把文件夹放进它自己里面");
      return;
    }
    if (
      paths.every((item) =>
        samePath(parentPath(item, platform) ?? "", target, platform),
      )
    ) {
      notify("文件已经在目标文件夹");
      return;
    }

    void api
      .transfer(kind, paths, target, "rename")
      .then(() => {
        notify(kind === "copy" ? "正在复制…" : "正在移动…");
        scheduleRefresh();
      })
      .catch((error) => notify(errorMessage(error)));
  };

  const copySelection = (cut: boolean) => {
    if (listing.selected.length === 0) return;
    void api
      .clipboard([...listing.selected], cut)
      .then(() =>
        notify(
          cut
            ? `已剪切 ${listing.selected.length} 项`
            : `已复制 ${listing.selected.length} 项`,
        ),
      )
      .catch((error) => notify(errorMessage(error)));
  };

  const paste = () => {
    void (async () => {
      try {
        const clip = await api.readClipboard();
        if (clip.paths.length === 0) {
          notify("剪贴板里没有文件");
          return;
        }
        transferInto(clip.paths, listing.path, clip.cut ? "move" : "copy");
      } catch (error) {
        notify(errorMessage(error));
      }
    })();
  };

  const startDrag = (
    event: ReactDragEvent<HTMLButtonElement>,
    entry: EntryDto,
  ) => {
    const paths =
      listing.selected.includes(entry.path) && listing.selected.length > 0
        ? [...listing.selected]
        : [entry.path];
    if (!listing.selected.includes(entry.path)) selectOnly(entry.path);
    setDragPayload(event, paths);
  };

  const hoverFolder = (entry: EntryDto) => {
    const dragging = getDraggedPaths();
    if (dragging.length === 0) return;
    if (dragging.some((item) => startsWithPath(entry.path, item, platform))) {
      return;
    }
    void navigate(entry.path, "push");
  };

  const queueDelete = (permanent: boolean) => {
    if (listing.selected.length === 0) return;
    setConfirmDelete({ paths: [...listing.selected], permanent });
  };

  const confirmRemove = async () => {
    if (!confirmDelete) return;
    try {
      await api.remove(confirmDelete.paths, confirmDelete.permanent);
      notify(confirmDelete.permanent ? "已永久删除" : "已移到回收站");
      setConfirmDelete(null);
      scheduleRefresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const startRename = () => {
    if (listing.selected.length !== 1) {
      notify(
        listing.selected.length === 0
          ? "先选择一个项目"
          : "批量重命名请在完整视图中使用",
      );
      return;
    }
    const entry = listing.entries.find(
      (item) => item.path === listing.selected[0],
    );
    if (entry) setRenaming({ entry, value: entry.name });
  };

  const submitRename = async () => {
    if (!renaming) return;
    const next = renaming.value.trim();
    if (!next) {
      notify("名称不能为空");
      return;
    }
    if (next === renaming.entry.name) {
      setRenaming(null);
      return;
    }
    try {
      await api.rename(renaming.entry.path, next);
      setRenaming(null);
      scheduleRefresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };

  const openMenu = (event: ReactMouseEvent, entry?: EntryDto) => {
    event.preventDefault();
    event.stopPropagation();
    if (entry && !listing.selected.includes(entry.path)) {
      selectOnly(entry.path);
    }
    const width = 196;
    const height = entry ? 250 : 150;
    setMenu({
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
      entry,
    });
  };

  // Rebuilt when the menu opens; the handlers intentionally come from that
  // render so the actions match the selection it was opened on.
  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return [];
    const selected = listing.selected;
    const items: MenuItem[] = [];
    if (menu.entry) {
      items.push({
        id: "open",
        label: "打开",
        onSelect: () => openEntry(menu.entry as EntryDto),
      });
    }
    items.push({
      id: "rename",
      label: "重命名",
      shortcut: "F2",
      disabled: selected.length !== 1,
      onSelect: startRename,
    });
    items.push({
      id: "delete",
      label: "移到回收站",
      shortcut: "Delete",
      danger: true,
      disabled: selected.length === 0,
      onSelect: () => queueDelete(false),
    });
    items.push({ id: "sep-1", separator: true });
    items.push({
      id: "copy",
      label: "复制",
      shortcut: "Ctrl+C",
      disabled: selected.length === 0,
      onSelect: () => copySelection(false),
    });
    items.push({
      id: "cut",
      label: "剪切",
      shortcut: "Ctrl+X",
      disabled: selected.length === 0,
      onSelect: () => copySelection(true),
    });
    items.push({ id: "paste", label: "粘贴", shortcut: "Ctrl+V", onSelect: paste });
    items.push({ id: "sep-2", separator: true });
    items.push({ id: "refresh", label: "刷新", shortcut: "F5", onSelect: refresh });
    items.push({
      id: "full-view",
      label: "在完整视图中打开",
      onSelect: () => onExit(listing.path),
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (renaming) {
      if (event.key === "Escape") setRenaming(null);
      return;
    }
    if (confirmDelete) {
      if (event.key === "Escape") setConfirmDelete(null);
      return;
    }
    if (menu) {
      if (event.key === "Escape") setMenu(null);
      return;
    }
    if (event.target instanceof HTMLInputElement) return;

    const key = event.key;
    const ctrl = event.ctrlKey || event.metaKey;
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (key === "ArrowDown" || key === "ArrowRight") {
      stop();
      moveSelection(1);
      return;
    }
    if (key === "ArrowUp" || key === "ArrowLeft") {
      stop();
      moveSelection(-1);
      return;
    }
    if (key === "Enter") {
      stop();
      openSelected();
      return;
    }
    if (key === "Backspace") {
      stop();
      const parent =
        listing.parent ?? parentPath(listing.path, platform) ?? null;
      if (parent) void navigate(parent, "push");
      return;
    }
    if (key === "Delete") {
      stop();
      queueDelete(event.shiftKey);
      return;
    }
    if (key === "F2") {
      stop();
      startRename();
      return;
    }
    if (key === "F5") {
      stop();
      refresh();
      return;
    }
    if (ctrl && key.toLowerCase() === "a") {
      stop();
      selectAll();
      return;
    }
    if (ctrl && key.toLowerCase() === "c") {
      stop();
      copySelection(false);
      return;
    }
    if (ctrl && key.toLowerCase() === "x") {
      stop();
      copySelection(true);
      return;
    }
    if (ctrl && key.toLowerCase() === "v") {
      stop();
      paste();
      return;
    }
    if (key === "Escape") {
      stop();
      clearSelection();
    }
  };

  const drop = useDropTarget({
    onDrop: (paths, event) => transferInto(paths, listing.path, dragKind(event)),
  });

  const thumbnailFor = (entry: EntryDto) => {
    if (entry.kind !== "file" || !THUMBNAIL_EXTENSIONS.has(entry.ext)) {
      return undefined;
    }
    return api.thumbnailUrl(entry.path, entry.mtimeMs, 96);
  };

  const updateView = (next: ViewMode) => {
    setView(next);
    memory.view = next;
  };

  const updateSort = (nextKey: SortKey) => {
    setSortKey(nextKey);
    memory.sortKey = nextKey;
  };

  const toggleDirection = () => {
    const next: SortDirection = sortDir === "asc" ? "desc" : "asc";
    setSortDir(next);
    memory.sortDir = next;
  };

  const items =
    view === "grid" ? (
      <div
        className="grid content-start gap-0.5 p-2"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(82px, 1fr))" }}
      >
        {sorted.map((entry, position) => (
          <PaneTile
            key={entry.path}
            entry={entry}
            index={position}
            view={view}
            selected={listing.selected.includes(entry.path)}
            shellIcon={
              entry.kind === "file" ? shellIcons[entry.path] : undefined
            }
            thumbnailUrl={thumbnailFor(entry)}
            showExtensions={showExtensions}
            onActivate={onActivate}
            onSelect={(event, item) => {
              if (event.shiftKey) selectRange(item.path);
              else if (event.ctrlKey || event.metaKey) toggleSelect(item.path);
              else selectOnly(item.path);
            }}
            onOpen={openEntry}
            onMenu={openMenu}
            onDragStart={startDrag}
            onDropInto={(item, paths, kind) => transferInto(paths, item.path, kind)}
            onHoverFolder={hoverFolder}
          />
        ))}
      </div>
    ) : (
      <div className="flex flex-col gap-0.5 p-1">
        {sorted.map((entry, position) => (
          <PaneTile
            key={entry.path}
            entry={entry}
            index={position}
            view={view}
            selected={listing.selected.includes(entry.path)}
            shellIcon={
              entry.kind === "file" ? shellIcons[entry.path] : undefined
            }
            thumbnailUrl={thumbnailFor(entry)}
            showExtensions={showExtensions}
            onActivate={onActivate}
            onSelect={(event, item) => {
              if (event.shiftKey) selectRange(item.path);
              else if (event.ctrlKey || event.metaKey) toggleSelect(item.path);
              else selectOnly(item.path);
            }}
            onOpen={openEntry}
            onMenu={openMenu}
            onDragStart={startDrag}
            onDropInto={(item, paths, kind) => transferInto(paths, item.path, kind)}
            onHoverFolder={hoverFolder}
          />
        ))}
      </div>
    );

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      data-pane-root={index}
      data-pane-active={active || undefined}
      onMouseDown={(event) => {
        onActivate();
        const target = event.target as HTMLElement;
        if (!target.closest("input, button, select, textarea")) {
          rootRef.current?.focus();
        }
      }}
      onKeyDown={onKeyDown}
      {...drop.dropProps}
      className={clsx(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-mac-surface outline-none",
        active && "ring-2 ring-inset ring-mac-blue/55",
      )}
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-mac-line bg-mac-chrome/70 px-1.5 py-1">
        <PaneButton
          label="后退"
          disabled={listing.historyIndex <= 0}
          onClick={() => {
            const target = listing.history[listing.historyIndex - 1];
            if (target) {
              void navigate(target, "none", listing.historyIndex - 1);
            }
          }}
        >
          <SFChevronLeft size={13} />
        </PaneButton>
        <PaneButton
          label="前进"
          disabled={listing.historyIndex >= listing.history.length - 1}
          onClick={() => {
            const target = listing.history[listing.historyIndex + 1];
            if (target) {
              void navigate(target, "none", listing.historyIndex + 1);
            }
          }}
        >
          <SFChevronRight size={13} />
        </PaneButton>
        <PaneButton
          label="上一级"
          disabled={!listing.parent}
          onClick={() => {
            if (listing.parent) void navigate(listing.parent, "push");
          }}
        >
          <SFChevronUp size={13} />
        </PaneButton>

        <div className="flex h-5 min-w-[90px] flex-1 items-center gap-1 rounded-[4px] bg-mac-surface px-1.5 shadow-[0_0_0_1px_var(--color-mac-line)] focus-within:ring-2 focus-within:ring-mac-blue/35">
          <SFFolderFill size={11} className="shrink-0 text-[#3d9bff]" />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => setAddress(listing.path)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                const target = address.trim();
                if (target) void navigate(target, "push");
              } else if (event.key === "Escape") {
                event.preventDefault();
                setAddress(listing.path);
                event.currentTarget.blur();
              }
            }}
            aria-label="窗格路径"
            spellCheck={false}
            className="w-full min-w-0 bg-transparent text-[11px] text-mac-text outline-none"
          />
        </div>

        <PaneButton
          label={view === "grid" ? "切换为列表" : "切换为网格"}
          onClick={() => updateView(view === "grid" ? "list" : "grid")}
        >
          {view === "grid" ? (
            <SFListBullet size={13} />
          ) : (
            <SFSquareGrid2x2 size={13} />
          )}
        </PaneButton>
        <button
          type="button"
          aria-label="排序方式"
          title="排序方式"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setSortMenu({ x: Math.round(rect.right - 132), y: Math.round(rect.bottom + 4) });
          }}
          className="flex h-5 shrink-0 items-center gap-0.5 rounded-[4px] px-1 text-[10.5px] text-mac-muted transition-colors hover:bg-black/[0.07] hover:text-mac-text dark:hover:bg-white/10"
        >
          {SORT_LABEL[sortKey]}
          <SFChevronDown size={8} className="opacity-60" />
        </button>
        <PaneButton
          label={sortDir === "asc" ? "改为降序" : "改为升序"}
          onClick={toggleDirection}
        >
          {sortDir === "asc" ? <SFArrowUp size={12} /> : <SFArrowDown size={12} />}
        </PaneButton>
        <PaneButton label="刷新" onClick={refresh}>
          <SFArrowClockwise size={12} />
        </PaneButton>
        <PaneButton label="在完整视图中打开" onClick={() => onExit(listing.path)}>
          <SFArrowUpRightSquare size={12} />
        </PaneButton>
      </div>

      <div
        data-pane-content={index}
        className="relative min-h-0 flex-1 overflow-auto"
        onContextMenu={(event) => openMenu(event)}
        onClick={(event) => {
          if (event.target === event.currentTarget) clearSelection();
        }}
      >
        {listing.loading && listing.entries.length === 0 ? (
          <div className="grid h-full place-items-center text-mac-muted">
            <Spinner size="sm" />
          </div>
        ) : listing.error ? (
          <div className="grid h-full place-items-center p-4 text-center">
            <div className="flex flex-col items-center gap-2">
              <p className="text-[11.5px] leading-4 text-mac-muted">
                {listing.error}
              </p>
              <button
                type="button"
                onClick={refresh}
                className="rounded-[5px] bg-mac-surface px-2.5 py-1 text-[11px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] hover:bg-black/[0.04] dark:hover:bg-white/[0.08]"
              >
                重试
              </button>
            </div>
          </div>
        ) : sorted.length === 0 ? (
          <div className="grid h-full place-items-center p-4 text-center">
            <p className="text-[11.5px] text-mac-muted">这个文件夹是空的</p>
          </div>
        ) : (
          items
        )}

        {drop.active && (
          <div className="pointer-events-none absolute inset-2 z-20 rounded-[10px] border-2 border-dashed border-mac-blue/70 bg-mac-blue/10" />
        )}
      </div>

      <div className="flex h-6 shrink-0 items-center gap-2 border-t border-mac-line px-2 text-[10.5px] text-mac-muted">
        <span className="tabular-nums">{sorted.length} 个项目</span>
        {listing.selected.length > 0 && (
          <span className="tabular-nums">· 已选 {listing.selected.length}</span>
        )}
        {drop.active && <span className="text-mac-blue">松开以放入</span>}
        <span className="ml-auto min-w-0 truncate" title={listing.path}>
          {basename(listing.path) || listing.path || "未打开文件夹"}
        </span>
      </div>

      {renaming && (
        <div
          className="absolute inset-0 z-30 grid place-items-center bg-black/20 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setRenaming(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
            onMouseDown={(event) => event.stopPropagation()}
            className="w-full max-w-[320px] rounded-[10px] border border-mac-line bg-mac-surface p-3 shadow-xl"
          >
            <div className="text-[12px] font-medium text-mac-text">重命名</div>
            <input
              autoFocus
              value={renaming.value}
              onChange={(event) =>
                setRenaming({ ...renaming, value: event.target.value })
              }
              className="mt-2 h-7 w-full rounded-[5px] bg-mac-bg px-2 text-[12px] text-mac-text outline-none ring-1 ring-inset ring-mac-line focus:ring-2 focus:ring-mac-blue/50"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenaming(null)}
                className="rounded-[5px] px-2.5 py-1 text-[11.5px] text-mac-muted hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
              >
                取消
              </button>
              <button
                type="submit"
                className="rounded-[5px] bg-mac-blue px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
              >
                重命名
              </button>
            </div>
          </form>
        </div>
      )}

      {confirmDelete && (
        <div
          className="absolute inset-0 z-30 grid place-items-center bg-black/20 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmDelete(null);
          }}
        >
          <div
            onMouseDown={(event) => event.stopPropagation()}
            className="w-full max-w-[340px] rounded-[10px] border border-mac-line bg-mac-surface p-3 shadow-xl"
          >
            <div className="text-[12px] font-medium text-mac-text">
              {confirmDelete.permanent ? "永久删除" : "移到回收站"}
            </div>
            <p className="mt-1 text-[11.5px] leading-4 text-mac-muted">
              将处理 {confirmDelete.paths.length} 个项目。
              {confirmDelete.permanent
                ? "永久删除后不能恢复。"
                : "之后可以从回收站还原。"}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="rounded-[5px] px-2.5 py-1 text-[11.5px] text-mac-muted hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmRemove()}
                className="rounded-[5px] bg-[#ff453a] px-2.5 py-1 text-[11.5px] font-medium text-white hover:opacity-90"
              >
                {confirmDelete.permanent ? "永久删除" : "移到回收站"}
              </button>
            </div>
          </div>
        </div>
      )}

      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          minWidth={196}
          zIndex={80}
          onClose={() => setMenu(null)}
        />
      )}

      {sortMenu && (
        <PopupMenu
          x={sortMenu.x}
          y={sortMenu.y}
          items={SORT_CHOICES.map((choice) => ({
            id: choice.value,
            label: choice.label,
            checked: sortKey === choice.value,
            onSelect: () => {
              updateSort(choice.value);
              setSortMenu(null);
            },
          }))}
          minWidth={132}
          zIndex={85}
          onClose={() => setSortMenu(null)}
        />
      )}
    </div>
  );
}
