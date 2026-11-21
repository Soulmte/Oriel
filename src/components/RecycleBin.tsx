import { useMemo, useState } from "react";
import {
  SFArrowUturnLeft,
  SFDocumentFill,
  SFFolderFill,
  SFTrashFill,
  SFTrashSlash,
} from "sf-symbols-lib/dualtone";
import { Button, Spinner } from "@heroui/react";
import { clsx } from "clsx";
import { useExplorer } from "../store/explorer";
import { useVirtualRows } from "../hooks/useVirtualRows";
import { formatBytes, formatDate } from "../lib/format";

const ROW_TEMPLATE = "grid-cols-[18px_minmax(0,1fr)_minmax(0,1.1fr)_130px_90px_72px]";
const ROW_HEIGHT = 30;

export function RecycleBin() {
  const items = useExplorer((state) => state.recycle.items);
  const total = useExplorer((state) => state.recycle.total);
  const loading = useExplorer((state) => state.recycle.loading);
  const skippedDrives = useExplorer((state) => state.recycle.skippedDrives);
  const loadRecycle = useExplorer((state) => state.loadRecycle);
  const restoreRecycle = useExplorer((state) => state.restoreRecycle);
  const openDialog = useExplorer((state) => state.openDialog);
  const emptyRecycle = useExplorer((state) => state.emptyRecycle);
  const closeRecycle = useExplorer((state) => state.closeRecycle);

  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  const selectedIds = useMemo(
    () => items.filter((item) => picked.has(item.id)).map((item) => item.id),
    [items, picked],
  );

  const toggle = (id: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allPicked = items.length > 0 && selectedIds.length === items.length;

  // A recycle bin can hold tens of thousands of entries; only render the rows
  // around the viewport like the file list does.
  const virtual = useVirtualRows({ count: items.length, rowHeight: ROW_HEIGHT });
  const { ref, onScroll, first, last, rows } = virtual;
  const visible = items.slice(first, last);

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
          还原选中
        </Button>
        <Button
          size="sm"
          variant="danger-soft"
          isDisabled={selectedIds.length === 0}
          onPress={() => openDialog({ kind: "confirm-purge", ids: selectedIds, all: false })}
        >
          永久删除
        </Button>
        <Button
          size="sm"
          variant="ghost"
          isDisabled={items.length === 0}
          onPress={() => openDialog({ kind: "confirm-purge", ids: [], all: true })}
        >
          清空废纸篓
        </Button>
      </div>

      {skippedDrives.length > 0 && (
        <div className="shrink-0 border-b border-mac-line bg-[#ff9f0a]/10 px-4 py-1 text-[11px] text-[#ff9f0a]">
          无法读取 {skippedDrives.join("、")} 的回收站（可能需要管理员权限）
        </div>
      )}

      <div
        className={clsx(
          "grid shrink-0 items-center border-b border-mac-line px-4 py-1 text-[11px] font-medium text-mac-muted",
          ROW_TEMPLATE,
        )}
      >
        <button
          type="button"
          aria-label={allPicked ? "取消全选" : "全选"}
          onClick={() => setPicked(allPicked ? new Set() : new Set(items.map((item) => item.id)))}
          className={clsx(
            "size-3.5 rounded-[3px] border",
            allPicked
              ? "border-mac-blue bg-mac-blue"
              : "border-black/25 dark:border-white/30",
          )}
        />
        <span className="px-1">名称</span>
        <span className="px-1">原位置</span>
        <span className="px-1">删除时间</span>
        <span className="px-1 text-right">大小</span>
        <span />
      </div>

      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 && !loading ? (
          <div className="grid h-full place-items-center px-6">
            <div className="flex flex-col items-center gap-2 text-center">
              <SFTrashFill size={26} className="text-mac-muted/60" />
              <p className="text-[12px] text-mac-muted">废纸篓是空的</p>
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
                  onClick={() => toggle(item.id)}
                  style={{ height: ROW_HEIGHT }}
                  className={clsx(
                    "grid cursor-default items-center px-4 text-[12.5px]",
                    ROW_TEMPLATE,
                    selected
                      ? "bg-mac-blue/15"
                      : "hover:bg-black/[0.035] dark:hover:bg-white/[0.06]",
                  )}
                >
                <span
                  className={clsx(
                    "size-3.5 rounded-[3px] border",
                    selected
                      ? "border-mac-blue bg-mac-blue"
                      : "border-black/25 dark:border-white/30",
                  )}
                />
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
                <span className="truncate px-1 text-[11.5px] text-mac-muted" title={item.originalPath}>
                  {item.originalPath}
                </span>
                <span className="truncate px-1 text-[11.5px] text-mac-muted">
                  {formatDate(item.deletedAt)}
                </span>
                <span className="px-1 text-right text-[11.5px] tabular-nums text-mac-muted">
                  {item.kind === "directory" ? "—" : formatBytes(item.size)}
                </span>
                <span className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    aria-label="还原"
                    title="还原到原位置"
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
                    aria-label="永久删除"
                    title="永久删除"
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
        <button type="button" onClick={() => void loadRecycle()} className="hover:text-mac-text">
          刷新
        </button>
        {selectedIds.length > 0 && <span>{selectedIds.length} 个已选择</span>}
        <span className="ml-auto">废纸篓中的项目会占用磁盘空间</span>
      </div>
    </div>
  );
}
