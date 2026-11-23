import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { EntryDto, SortKey } from "@oriel/shared";
import { ChevronDown, ChevronUp } from "lucide-react";
import { clsx } from "clsx";
import { useExplorer } from "../store/explorer";
import type { ListColumnKey } from "../store/explorer";
import { groupEntries } from "../lib/grouping";
import { useInView } from "../hooks/useInView";
import { useVirtualRows } from "../hooks/useVirtualRows";
import { useMarqueeSelection } from "../hooks/useMarquee";
import { useDropTarget } from "../hooks/useDropTarget";
import { useDoubleClickOpen } from "../hooks/useDoubleClickOpen";
import {
  displayName,
  fileKindLabel,
  formatBytes,
  formatDate,
  sortEntriesCached,
  startsWithPath,
} from "../lib/format";
import { DENSITY_ROW_HEIGHT } from "../lib/appearance";
import { isArchivePath } from "../lib/archivePath";
import { dragKind, getDraggedPaths, setDragPayload } from "../lib/dnd";
import { FileIcon } from "../lib/fileIcons";

const COLUMNS: Array<{ key: SortKey; label: string; className: string }> = [
  { key: "name", label: "名称", className: "" },
  { key: "date", label: "修改日期", className: "" },
  { key: "size", label: "大小", className: "text-right" },
  { key: "kind", label: "种类", className: "" },
];

const DEFAULT_ROW_HEIGHT = 28;
/**
 * Column set from the measured width plus the user's column choices. Width
 * still wins: a narrow window drops date/kind so the name never collapses.
 */
function columnsFor(
  width: number,
  visible: ListColumnKey[],
): {
  template: string;
  date: boolean;
  size: boolean;
  kind: boolean;
} {
  const date = width >= 440 && visible.includes("date");
  const size = visible.includes("size");
  const kind = width >= 680 && visible.includes("kind");

  const parts = ["minmax(150px, 1fr)"];
  if (date) parts.push("130px");
  if (size) parts.push("78px");
  if (kind) parts.push("minmax(70px, 110px)");

  return { template: parts.join(" "), date, size, kind };
}

/**
 * Folder sizes are expensive, so a row only asks for one once it scrolls into
 * view; the store batches those requests and caches the answers.
 */
function FolderSizeCell({ path, selected }: { path: string; selected: boolean }) {
  const size = useExplorer((state) => state.folderSizes[path]);
  const request = useExplorer((state) => state.requestFolderSizes);
  const { ref, inView } = useInView<HTMLDivElement>();

  const archive = isArchivePath(path);

  useEffect(() => {
    if (inView && !archive) request([path]);
  }, [inView, path, request, archive]);

  return (
    <div
      ref={ref}
      className={clsx(
        "px-1 text-right tabular-nums",
        selected ? "text-white/80" : "text-mac-muted",
      )}
    >
      {archive
        ? "—"
        : size
          ? `${formatBytes(size.size)}${size.partial ? "+" : ""}`
          : "…"}
    </div>
  );
}

function ListRow({
  entry,
  isSelected,
  showExtensions,
  template,
  showDate,
  showSize,
  showKind,
  rowHeight,
}: {
  entry: EntryDto;
  isSelected: boolean;
  showExtensions: boolean;
  template: string;
  showDate: boolean;
  showSize: boolean;
  showKind: boolean;
  rowHeight: number;
}) {
  const shellIcon = useExplorer((state) =>
    entry.kind === "file" ? state.shellIcons[entry.path] : undefined,
  );
  const selectOnly = useExplorer((state) => state.selectOnly);
  const toggleSelect = useExplorer((state) => state.toggleSelect);
  const selectRange = useExplorer((state) => state.selectRange);
  const openEntry = useExplorer((state) => state.openEntry);
  const setContextMenu = useExplorer((state) => state.setContextMenu);
  const navigate = useExplorer((state) => state.navigate);
  const dropPaths = useExplorer((state) => state.dropPaths);
  const platform = useExplorer((state) => state.system?.platform ?? "win32");
  const singleClickOpen = useExplorer((state) => state.singleClickOpen);
  const openOnClick = useDoubleClickOpen(() => void openEntry(entry), singleClickOpen);

  const drop = useDropTarget({
    enabled: entry.kind === "directory",
    onDrop: (paths, event) => void dropPaths(paths, entry.path, dragKind(event)),
    onHover: () => {
      const dragging = getDraggedPaths();
      if (dragging.some((item) => startsWithPath(entry.path, item, platform))) return;
      void navigate(entry.path);
    },
  });

  return (
    <div
      data-entry
      data-entry-path={entry.path}
      data-selected={isSelected}
      draggable
      style={{ height: rowHeight, gridTemplateColumns: template }}
      onClick={(event) => {
        if (event.shiftKey) selectRange(entry.path);
        else if (event.ctrlKey || event.metaKey) toggleSelect(entry.path);
        else selectOnly(entry.path);
        openOnClick(entry.path, event);
      }}
      onDragStart={(event) => {
        const state = useExplorer.getState();
        const paths =
          state.selected.includes(entry.path) && state.selected.length > 0
            ? [...state.selected]
            : [entry.path];
        if (!state.selected.includes(entry.path)) state.selectOnly(entry.path);
        setDragPayload(event, paths);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!isSelected) selectOnly(entry.path);
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          entry,
        });
      }}
      {...drop.dropProps}
      className={clsx(
        "grid cursor-default touch-manipulation items-center px-4 text-[12.5px]",
        drop.active
          ? "bg-mac-blue/25 ring-1 ring-inset ring-mac-blue"
          : isSelected
            ? "bg-mac-blue text-white"
            : "hover:bg-black/[0.035] dark:hover:bg-white/[0.06]",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5 px-1">
        <FileIcon entry={entry} size={18} shellIcon={shellIcon} />
        <span className="truncate" title={entry.name}>
          {displayName(entry, showExtensions)}
        </span>
      </div>
      {showDate && (
        <div
          className={clsx(
            "truncate px-1",
            isSelected && !drop.active ? "text-white/80" : "text-mac-muted",
          )}
        >
          {formatDate(entry.mtimeMs)}
        </div>
      )}
      {showSize &&
        (entry.kind === "directory" ? (
          <FolderSizeCell path={entry.path} selected={isSelected && !drop.active} />
        ) : (
          <div
            className={clsx(
              "px-1 text-right tabular-nums",
              isSelected && !drop.active ? "text-white/80" : "text-mac-muted",
            )}
          >
            {formatBytes(entry.size)}
          </div>
        ))}
      {showKind && (
        <div
          className={clsx(
            "truncate px-1",
            isSelected && !drop.active ? "text-white/80" : "text-mac-muted",
          )}
        >
          {fileKindLabel(entry)}
        </div>
      )}
    </div>
  );
}

export function FileList({ entries }: { entries: EntryDto[] }) {
  const sortKey = useExplorer((state) => state.sortKey);
  const sortDir = useExplorer((state) => state.sortDir);
  const setSort = useExplorer((state) => state.setSort);
  const selected = useExplorer((state) => state.selected);
  const selectPaths = useExplorer((state) => state.selectPaths);
  const clearSelection = useExplorer((state) => state.clearSelection);
  const setContextMenu = useExplorer((state) => state.setContextMenu);
  const dropPaths = useExplorer((state) => state.dropPaths);

  const groupKey = useExplorer((state) => state.groupKey);
  const showExtensions = useExplorer((state) => state.appearance.showExtensions);
  const listColumns = useExplorer((state) => state.listColumns);
  const density = useExplorer((state) => state.appearance.density);
  const rememberedScroll = useExplorer((state) => state.pendingScrollTop);
  const rememberScrollTop = useExplorer((state) => state.rememberScrollTop);
  const [containerWidth, setContainerWidth] = useState(0);

  const ROW_HEIGHT = DENSITY_ROW_HEIGHT[density] ?? DEFAULT_ROW_HEIGHT;

  const list = useMemo(
    () => sortEntriesCached(entries, sortKey, sortDir),
    [entries, sortKey, sortDir],
  );

  type Row =
    | { type: "header"; id: string; label: string; count: number }
    | { type: "entry"; entry: EntryDto; key: string };

  const rowModel = useMemo<Row[]>(() => {
    const groups = groupEntries(list, groupKey);
    if (!groups) {
      return list.map((entry) => ({ type: "entry", entry, key: entry.path }));
    }
    const out: Row[] = [];
    for (const group of groups) {
      out.push({
        type: "header",
        id: group.id,
        label: group.label,
        count: group.entries.length,
      });
      for (const entry of group.entries) {
        out.push({ type: "entry", entry, key: `${group.id}:${entry.path}` });
      }
    }
    return out;
  }, [list, groupKey]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const virtual = useVirtualRows({ count: rowModel.length, rowHeight: ROW_HEIGHT });
  const columns = columnsFor(containerWidth, listColumns);
  const { ref, onScroll, first, last, rows } = virtual;

  const getSelection = useCallback(() => useExplorer.getState().selected, []);
  const marquee = useMarqueeSelection({
    containerRef: ref,
    getSelection,
    onSelect: selectPaths,
  });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setContainerWidth(node.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);

  // Restore the scroll offset the folder had last time, once per navigation.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || rememberedScroll === null) return;
    node.scrollTop = rememberedScroll;
    useExplorer.setState({ pendingScrollTop: null });
  }, [ref, rememberedScroll, rowModel.length]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      onScroll(event);
      rememberScrollTop(event.currentTarget.scrollTop);
    },
    [onScroll, rememberScrollTop],
  );

  const scrollToSelection = useCallback(() => {
    // Only chase single selections: Ctrl+A / shift ranges should not jump the
    // viewport to the last item.
    if (selected.length !== 1) return;
    const target = selected[0];
    const index = rowModel.findIndex(
      (row) => row.type === "entry" && row.entry.path === target,
    );
    if (index < 0) return;

    const node = ref.current;
    if (!node) return;

    const top = index * ROW_HEIGHT;
    const viewTop = node.scrollTop;
    const viewBottom = viewTop + node.clientHeight;

    if (top < viewTop) node.scrollTop = Math.max(0, top - ROW_HEIGHT);
    else if (top + ROW_HEIGHT > viewBottom) {
      node.scrollTop = top - node.clientHeight + ROW_HEIGHT * 2;
    }
  }, [rowModel, ref, selected]);

  useEffect(scrollToSelection, [scrollToSelection]);

  const canvas = useDropTarget({
    onDrop: (paths, event) => {
      const target = useExplorer.getState().path;
      if (target) void dropPaths(paths, target, dragKind(event));
    },
  });

  const rendered: number[] = [];
  for (let row = first; row < last; row += 1) rendered.push(row);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        style={{ gridTemplateColumns: columns.template }}
        className={clsx(
          "grid shrink-0 items-center border-b border-mac-line px-4 py-1 text-[11px] font-medium text-mac-muted",
        )}
      >
        {COLUMNS.filter(
          (column) =>
            column.key === "name" ||
            (column.key === "date" && columns.date) ||
            (column.key === "size" && columns.size) ||
            (column.key === "kind" && columns.kind),
        ).map((column) => (
          <button
            key={column.key}
            type="button"
            onClick={() => setSort(column.key)}
            className={clsx(
              "flex items-center gap-1 px-1 text-left transition-colors hover:text-mac-text",
              column.className,
              column.className === "text-right" && "justify-end",
            )}
          >
            <span>{column.label}</span>
            {sortKey === column.key &&
              (sortDir === "asc" ? (
                <ChevronUp className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              ))}
          </button>
        ))}
      </div>

      <div
        ref={ref}
        onScroll={handleScroll}
        className="relative min-h-0 flex-1 overflow-auto"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("[data-entry]")) return;
          clearSelection();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          if ((event.target as HTMLElement).closest("[data-entry]")) return;
          // Keep the current selection: the blank-area menu offers actions for
          // "the selection" (compress, batch rename), so clearing here hid them.
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
        {...canvas.dropProps}
      >
        <div style={{ height: rows * ROW_HEIGHT }}>
          {first > 0 && <div style={{ height: first * ROW_HEIGHT }} />}

          {rendered.map((index) => {
            const row = rowModel[index];
            if (!row) return null;

            if (row.type === "header") {
              return (
                <div
                  key={`h:${row.id}`}
                  style={{ height: ROW_HEIGHT }}
                  className="sticky top-0 z-[1] flex items-center gap-2 bg-mac-chrome px-4 text-[10.5px] font-semibold tracking-wide text-mac-muted"
                >
                  <span>{row.label}</span>
                  <span className="font-normal text-mac-muted tabular-nums">
                    {row.count}
                  </span>
                </div>
              );
            }

            return (
              <ListRow
                key={row.key}
                entry={row.entry}
                isSelected={selectedSet.has(row.entry.path)}
                showExtensions={showExtensions}
                template={columns.template}
                showDate={columns.date}
                showSize={columns.size}
                showKind={columns.kind}
                rowHeight={ROW_HEIGHT}
              />
            );
          })}

          {last < rows && <div style={{ height: (rows - last) * ROW_HEIGHT }} />}
        </div>

        {marquee && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-20 rounded-[2px] border border-mac-blue/80 bg-mac-blue/15"
            style={{
              left: marquee.left,
              top: marquee.top,
              width: marquee.width,
              height: marquee.height,
            }}
          />
        )}
      </div>
    </div>
  );
}
