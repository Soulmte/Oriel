import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SFArrowUturnLeft,
  SFChevronDown,
  SFChevronUp,
  SFDocumentFill,
  SFFolderFill,
  SFTrashFill,
  SFTrashSlash,
} from "sf-symbols-lib/dualtone";
import { Button, Spinner } from "@heroui/react";
import { clsx } from "clsx";
import { useExplorer } from "../store/explorer";
import { useVirtualRows } from "../hooks/useVirtualRows";
import { PopupMenu } from "./PopupMenu";
import type { MenuItem } from "./PopupMenu";
import { formatBytes, formatDate } from "../lib/format";

const ROW_TEMPLATE = "grid-cols-[16px_minmax(0,1fr)_minmax(0,1.1fr)_128px_88px_60px]";
const ROW_HEIGHT = 30;

type SortKey = "name" | "date" | "size";

function Check({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "grid size-[15px] place-items-center rounded-[4px] border transition-colors",
        checked
          ? "border-mac-blue bg-mac-blue text-white"
          : "border-black/25 bg-transparent dark:border-white/30",
      )}
    >
      {checked && (
        <svg width="9" height="9" viewBox="0 0 10 10">
          <path
            d="M1.6 5.2 3.9 7.4 8.4 2.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

function SortHeader({
  label,
  active,
  direction,
  align = "left",
  onClick,
}: {
  label: string;
  active: boolean;
  direction: "asc" | "desc";
  align?: "left" | "right";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "flex items-center gap-1 px-1 text-[11px] font-medium",
        align === "right" && "justify-end",
        active ? "text-mac-text" : "text-mac-muted hover:text-mac-text",
      )}
    >
      {label}
      {active &&
        (direction === "asc" ? (
          <SFChevronUp size={8} className="opacity-70" />
        ) : (
          <SFChevronDown size={8} className="opacity-70" />
        ))}
    </button>
  );
}

/**
 * Finder-style trash. Selection, sortable columns, keyboard shortcuts and the
 * same contextual menu as the file list; rows are virtualised because a bin
 * can hold tens of thousands of stale sidecars.
 */
export function RecycleBin() {
  const items = useExplorer((state) => state.recycle.items);
  const total = useExplorer((state) => state.recycle.total);
  const loading = useExplorer((state) => state.recycle.loading);
  const skippedDrives = useExplorer((state) => state.recycle.skippedDrives);
  const loadRecycle = useExplorer((state) => state.loadRecycle);
  const restoreRecycle = useExplorer((state) => state.restoreRecycle);
  const openDialog = useExplorer((state) => state.openDialog);
  const closeRecycle = useExplorer((state) => state.closeRecycle);
  const notify = useExplorer((state) => state.notify);

  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const sorted = useMemo(() => {
    const list = [...items];
    list.sort((a, b) => {
      let result = 0;
      if (sortKey === "name") result = a.name.localeCompare(b.name, "zh");
      else if (sortKey === "size") result = a.size - b.size;
      else result = a.deletedAt - b.deletedAt;
      return sortDir === "asc" ? result : -result;
    });
    return list;
  }, [items, sortKey, sortDir]);

  const selectedIds = useMemo(
    () => sorted.filter((item) => picked.has(item.id)).map((item) => item.id),
    [sorted, picked],
  );
  const selectedSize = useMemo(
    () =>
      sorted
        .filter((item) => picked.has(item.id))
        .reduce((sum, item) => sum + item.size, 0),
    [sorted, picked],
  );

  const allPicked = sorted.length > 0 && selectedIds.length === sorted.length;

  const selectAll = useCallback(() => {
    setPicked((current) =>
      current.size === sorted.length ? new Set() : new Set(sorted.map((item) => item.id)),
    );
  }, [sorted]);

  const toggle = useCallback(
    (id: string, event: { shiftKey: boolean }) => {
      setPicked((current) => {
        const next = new Set(current);
        if (event.shiftKey && anchor) {
          const from = sorted.findIndex((item) => item.id === anchor);
          const to = sorted.findIndex((item) => item.id === id);
          if (from >= 0 && to >= 0) {
            for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) {
              next.add(sorted[index]!.id);
            }
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setAnchor(id);
    },
    [anchor, sorted],
  );

  const changeSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  // Keep the selection honest when a restore or purge removes rows.
  useEffect(() => {
    const ids = new Set(items.map((item) => item.id));
    setPicked((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAll();
        return;
      }
      if (event.key === "Escape") {
        if (picked.size > 0) {
          event.preventDefault();
          setPicked(new Set());
        }
        return;
      }
      if (event.key === "Enter" && selectedIds.length > 0) {
        event.preventDefault();
        void restoreRecycle(selectedIds);
        return;
      }
      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedIds.length > 0
      ) {
        event.preventDefault();
        openDialog({ kind: "confirm-purge", ids: selectedIds, all: false });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openDialog, picked.size, restoreRecycle, selectAll, selectedIds]);

  const menuItems: MenuItem[] = useMemo(() => {
    const ids = menu
      ? picked.has(menu.id)
        ? selectedIds
        : [menu.id]
      : selectedIds;
    const item = menu ? items.find((entry) => entry.id === menu.id) : undefined;
    return [
      {
        id: "restore",
        label: ids.length > 1 ? `放回原处（${ids.length} 项）` : "放回原处",
        onSelect: () => void restoreRecycle(ids),
      },
      {
        id: "purge",
        label: ids.length > 1 ? `立即删除（${ids.length} 项）` : "立即删除",
        danger: true,
        onSelect: () => openDialog({ kind: "confirm-purge", ids, all: false }),
      },
      { id: "sep", separator: true },
      {
        id: "copy-path",
        label: "复制原位置",
        disabled: !item,
        onSelect: () => {
          if (!item) return;
          void navigator.clipboard
            .writeText(item.originalPath)
            .then(() => notify("已复制原位置"))
            .catch(() => notify("复制失败"));
        },
      },
    ];
  }, [items, menu, notify, openDialog, picked, restoreRecycle, selectedIds]);

  const virtual = useVirtualRows({ count: sorted.length, rowHeight: ROW_HEIGHT });
  const { ref, onScroll, first, last, rows } = virtual;
  const visible = sorted.slice(first, last);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-mac-surface">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-mac-line px-4">
        <SFTrashFill size={15} className="text-mac-muted" />
        <span className="text-[13px] font-medium text-mac-text">废纸篓</span>
        <span className="text-[11px] tabular-nums text-mac-muted">
          {items.length} 个项目 · {formatBytes(total)}
        </span>

        <span className="flex-1" />

        {loading && <Spinner size="sm" />}
        <Button
          size="sm"
          variant="ghost"
          isDisabled={selectedIds.length === 0}
          onPress={() => void restoreRecycle(selectedIds)}
        >
          <SFArrowUturnLeft size={13} />
          还原
        </Button>
        <Button
          size="sm"
          variant="danger-soft"
          isDisabled={selectedIds.length === 0}
          onPress={() => openDialog({ kind: "confirm-purge", ids: selectedIds, all: false })}
        >
          <SFTrashSlash size={13} />
          立即删除
        </Button>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={items.length === 0}
          onPress={() => openDialog({ kind: "confirm-purge", ids: [], all: true })}
        >
          清空
        </Button>
      </div>

      {skippedDrives.length > 0 && (
        <div className="shrink-0 border-b border-mac-line bg-[#ff9f0a]/10 px-4 py-1 text-[11px] text-[#ff9f0a]">
          无法读取 {skippedDrives.join("、")} 的回收站（可能需要管理员权限）
        </div>
      )}

      <div
        className={clsx(
          "grid shrink-0 items-center border-b border-mac-line px-4 py-1.5",
          ROW_TEMPLATE,
        )}
      >
        <button
          type="button"
          aria-label={allPicked ? "取消全选" : "全选"}
          aria-pressed={allPicked}
          onClick={selectAll}
          className="grid place-items-start"
        >
          <Check checked={allPicked} />
        </button>
        <SortHeader
          label="名称"
          active={sortKey === "name"}
          direction={sortDir}
          onClick={() => changeSort("name")}
        />
        <span className="px-1 text-[11px] font-medium text-mac-muted">原位置</span>
        <SortHeader
          label="删除时间"
          active={sortKey === "date"}
          direction={sortDir}
          onClick={() => changeSort("date")}
        />
        <SortHeader
          label="大小"
          active={sortKey === "size"}
          direction={sortDir}
          align="right"
          onClick={() => changeSort("size")}
        />
        <span />
      </div>

      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && !loading ? (
          <div className="grid h-full place-items-center px-6">
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="grid size-16 place-items-center rounded-full bg-black/[0.045] dark:bg-white/[0.06]">
                <SFTrashFill size={30} className="text-mac-muted/70" />
              </span>
              <div>
                <p className="text-[13px] text-mac-text">废纸篓是空的</p>
                <p className="mt-1 text-[11.5px] text-mac-muted">
                  删除的文件会先到这里，再决定是否永久删除
                </p>
              </div>
              <Button size="sm" variant="secondary" onPress={closeRecycle}>
                返回文件
              </Button>
            </div>
          </div>
        ) : (
          <div style={{ height: rows * ROW_HEIGHT }}>
            {first > 0 && <div style={{ height: first * ROW_HEIGHT }} />}
            {visible.map((item) => {
              const selected = picked.has(item.id);
              return (
                <div
                  key={item.id}
                  onClick={(event) => toggle(item.id, event)}
                  onDoubleClick={() => void restoreRecycle([item.id])}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!picked.has(item.id)) {
                      setPicked(new Set([item.id]));
                      setAnchor(item.id);
                    }
                    setMenu({ x: event.clientX, y: event.clientY, id: item.id });
                  }}
                  style={{ height: ROW_HEIGHT }}
                  className={clsx(
                    "group grid cursor-default items-center px-4 text-[12.5px]",
                    ROW_TEMPLATE,
                    selected
                      ? "bg-mac-blue/15"
                      : "hover:bg-black/[0.035] dark:hover:bg-white/[0.06]",
                  )}
                >
                  <span className="grid place-items-start">
                    <Check checked={selected} />
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 px-1">
                    {item.kind === "directory" ? (
                      <SFFolderFill size={16} className="shrink-0 text-[#3d9bff]" />
                    ) : (
                      <SFDocumentFill size={16} className="shrink-0 text-[#98989f]" />
                    )}
                    <span className="truncate" title={item.originalPath}>
                      {item.name}
                    </span>
                  </span>
                  <span
                    className="truncate px-1 text-[11.5px] text-mac-muted"
                    title={item.originalPath}
                  >
                    {item.originalPath}
                  </span>
                  <span className="truncate px-1 text-[11.5px] text-mac-muted">
                    {formatDate(item.deletedAt)}
                  </span>
                  <span className="px-1 text-right text-[11.5px] tabular-nums text-mac-muted">
                    {item.kind === "directory" ? "—" : formatBytes(item.size)}
                  </span>
                  <span className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <button
                      type="button"
                      aria-label="放回原处"
                      title="放回原处（Enter）"
                      onClick={(event) => {
                        event.stopPropagation();
                        void restoreRecycle([item.id]);
                      }}
                      className="grid size-6 place-items-center rounded-[5px] text-mac-muted hover:bg-black/[0.07] hover:text-mac-text dark:hover:bg-white/10"
                    >
                      <SFArrowUturnLeft size={13} />
                    </button>
                    <button
                      type="button"
                      aria-label="立即删除"
                      title="立即删除（Delete）"
                      onClick={(event) => {
                        event.stopPropagation();
                        openDialog({ kind: "confirm-purge", ids: [item.id], all: false });
                      }}
                      className="grid size-6 place-items-center rounded-[5px] text-mac-muted hover:bg-[#ff3b30]/15 hover:text-[#ff3b30]"
                    >
                      <SFTrashSlash size={13} />
                    </button>
                  </span>
                </div>
              );
            })}
            {last < rows && <div style={{ height: (rows - last) * ROW_HEIGHT }} />}
          </div>
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-mac-line px-4 text-[11px] text-mac-muted">
        <button
          type="button"
          onClick={() => void loadRecycle()}
          className="hover:text-mac-text"
        >
          刷新
        </button>
        {selectedIds.length > 0 ? (
          <span className="tabular-nums">
            {selectedIds.length} 个已选择
            {selectedSize > 0 ? ` · ${formatBytes(selectedSize)}` : ""}
          </span>
        ) : (
          <span>双击还原 · Delete 立即删除</span>
        )}
        <span className="ml-auto">废纸篓中的项目会占用磁盘空间</span>
      </div>

      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          minWidth={188}
          zIndex={90}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
