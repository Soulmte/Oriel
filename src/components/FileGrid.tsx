import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EntryDto } from "@oriel/shared";
import { clsx } from "clsx";
import { useExplorer } from "../store/explorer";
import { useVirtualRows } from "../hooks/useVirtualRows";
import { useMarqueeSelection } from "../hooks/useMarquee";
import { useDropTarget } from "../hooks/useDropTarget";
import { displayName, sortEntriesCached, startsWithPath } from "../lib/format";
import { GRID_METRICS } from "../lib/appearance";
import type { GridSize } from "../lib/appearance";
import { dragKind, getDraggedPaths, setDragPayload } from "../lib/dnd";
import { FileIcon, thumbnailFor } from "../lib/fileIcons";

const GAP_X = 8;
const GAP_Y = 12;
const PADDING_X = 20;
const PADDING_Y = 16;

function metricsFor(size: GridSize) {
  const base = GRID_METRICS[size];
  return { ...base, rowHeight: base.itemHeight + GAP_Y };
}

function GridTile({
  entry,
  isSelected,
  metrics,
  showExtensions,
}: {
  entry: EntryDto;
  isSelected: boolean;
  metrics: ReturnType<typeof metricsFor>;
  showExtensions: boolean;
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

  const drop = useDropTarget({
    enabled: entry.kind === "directory",
    onDrop: (paths, event) => void dropPaths(paths, entry.path, dragKind(event)),
    // Hovering a folder mid-drag opens it, but never into the dragged subtree.
    onHover: () => {
      const dragging = getDraggedPaths();
      if (dragging.some((item) => startsWithPath(entry.path, item, platform))) return;
      void navigate(entry.path);
    },
  });

  return (
    <button
      type="button"
      data-entry
      data-entry-path={entry.path}
      data-selected={isSelected}
      data-drop-active={drop.active || undefined}
      draggable
      style={{ width: metrics.itemWidth, height: metrics.itemHeight }}
      onClick={(event) => {
        if (event.shiftKey) selectRange(entry.path);
        else if (event.ctrlKey || event.metaKey) toggleSelect(entry.path);
        else selectOnly(entry.path);
      }}
      onDoubleClick={() => void openEntry(entry)}
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
      className="group flex flex-col items-center gap-1.5 rounded-lg py-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-mac-blue/60"
    >
      <span
        style={{ width: metrics.labelWidth }}
        className={clsx(
          "flex flex-col items-center gap-1.5 rounded-[8px] px-1.5 pb-1.5 pt-1 transition-colors",
          drop.active
            ? "bg-mac-blue/25 ring-2 ring-mac-blue"
            : isSelected
              ? "bg-mac-blue/90 shadow-sm"
              : "group-hover:bg-black/[0.05] dark:group-hover:bg-white/[0.08]",
        )}
      >
        <FileIcon
          entry={entry}
          size={metrics.iconSize}
          shellIcon={shellIcon}
          thumbnailUrl={thumbnailFor(entry, metrics.iconSize * 2)}
        />
        <span
          title={entry.name}
          className={clsx(
            "line-clamp-2 w-full break-words text-[12px] leading-4",
            isSelected && !drop.active ? "text-white" : "text-mac-text",
          )}
        >
          {displayName(entry, showExtensions)}
        </span>
      </span>
    </button>
  );
}

export function FileGrid({ entries }: { entries: EntryDto[] }) {
  const sortKey = useExplorer((state) => state.sortKey);
  const sortDir = useExplorer((state) => state.sortDir);
  const selected = useExplorer((state) => state.selected);
  const selectOnly = useExplorer((state) => state.selectOnly);
  const selectPaths = useExplorer((state) => state.selectPaths);
  const clearSelection = useExplorer((state) => state.clearSelection);
  const setContextMenu = useExplorer((state) => state.setContextMenu);
  const dropPaths = useExplorer((state) => state.dropPaths);
  const appearance = useExplorer((state) => state.appearance);
  const rememberedScroll = useExplorer((state) => state.pendingScrollTop);
  const rememberScrollTop = useExplorer((state) => state.rememberScrollTop);

  const metrics = useMemo(() => metricsFor(appearance.gridSize), [appearance.gridSize]);

  const list = useMemo(
    () => sortEntriesCached(entries, sortKey, sortDir),
    [entries, sortKey, sortDir],
  );
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const [columns, setColumns] = useState(1);
  const virtual = useVirtualRows({
    count: list.length,
    rowHeight: metrics.rowHeight,
    columns,
  });
  const { ref, onScroll, first, last, rows } = virtual;

  const getSelection = useCallback(() => useExplorer.getState().selected, []);
  const marquee = useMarqueeSelection({
    containerRef: ref,
    getSelection,
    onSelect: selectPaths,
  });

  // Column count follows the container width; ResizeObserver keeps it correct
  // when the preview panel is toggled or resized.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    const update = () => {
      const usable = node.clientWidth - PADDING_X * 2;
      setColumns(
        Math.max(1, Math.floor((usable + GAP_X) / (metrics.itemWidth + GAP_X))),
      );
    };

    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, metrics.itemWidth]);

  // Keep the selected entry visible without relying on it being rendered.
  const selectionEffect = useCallback(() => {
    // Only chase single selections: Ctrl+A / shift ranges should not jump the
    // viewport to the last item.
    if (selected.length !== 1) return;
    const target = selected[0];
    const index = list.findIndex((entry) => entry.path === target);
    if (index < 0) return;

    const node = ref.current;
    if (!node) return;

    const rowTop = Math.floor(index / Math.max(1, columns)) * metrics.rowHeight;
    const viewTop = node.scrollTop;
    const viewBottom = viewTop + node.clientHeight - PADDING_Y * 2;

    if (rowTop < viewTop) {
      node.scrollTop = Math.max(0, rowTop - PADDING_Y);
    } else if (rowTop + metrics.itemHeight > viewBottom) {
      node.scrollTop = rowTop - node.clientHeight + metrics.rowHeight + PADDING_Y;
    }
  }, [columns, list, ref, selected, metrics]);

  useEffect(selectionEffect, [selectionEffect]);

  // Dropping on empty canvas moves into the folder being viewed.
  const canvas = useDropTarget({
    onDrop: (paths, event) => {
      const target = useExplorer.getState().path;
      if (target) void dropPaths(paths, target, dragKind(event));
    },
  });

  // Restore the scroll offset the folder had last time, once per navigation.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || rememberedScroll === null) return;
    node.scrollTop = rememberedScroll;
    useExplorer.setState({ pendingScrollTop: null });
  }, [ref, rememberedScroll, list.length]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      onScroll(event);
      rememberScrollTop(event.currentTarget.scrollTop);
    },
    [onScroll, rememberScrollTop],
  );

  const rendered: number[] = [];
  for (let row = first; row < last; row += 1) rendered.push(row);

  return (
    <div
      ref={ref}
      onScroll={handleScroll}
      className="relative h-full overflow-y-auto"
      style={{ padding: `${PADDING_Y}px ${PADDING_X}px` }}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("[data-entry]")) return;
        clearSelection();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if ((event.target as HTMLElement).closest("[data-entry]")) return;
        clearSelection();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
      {...canvas.dropProps}
    >
      <div style={{ height: rows * metrics.rowHeight }}>
        {first > 0 && <div style={{ height: first * metrics.rowHeight }} />}

        {rendered.map((row) => {
          const start = row * columns;
          const items = list.slice(start, start + columns);

          return (
            <div
              key={row}
              className="flex"
              style={{ height: metrics.itemHeight, marginBottom: GAP_Y, gap: GAP_X }}
            >
              {items.map((entry) => (
                <GridTile
                  key={entry.path}
                  entry={entry}
                  isSelected={selectedSet.has(entry.path)}
                  metrics={metrics}
                  showExtensions={appearance.showExtensions}
                />
              ))}
            </div>
          );
        })}

        {last < rows && <div style={{ height: (rows - last) * metrics.rowHeight }} />}
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
  );
}
