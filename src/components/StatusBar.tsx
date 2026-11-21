import { useMemo } from "react";
import { useExplorer } from "../store/explorer";
import { api } from "../lib/api";
import { clsx } from "clsx";
import { SFXmark } from "sf-symbols-lib/dualtone";
import { formatBytes, startsWithPath } from "../lib/format";

export function StatusBar() {
  const entries = useExplorer((state) => state.entries);
  const results = useExplorer((state) => state.results);
  const query = useExplorer((state) => state.query);
  const selected = useExplorer((state) => state.selected);
  const searching = useExplorer((state) => state.searching);
  const searchTruncated = useExplorer((state) => state.searchTruncated);
  const searchScanned = useExplorer((state) => state.searchScanned);
  const searchTimedOut = useExplorer((state) => state.searchTimedOut);
  const drives = useExplorer((state) => state.drives);
  const path = useExplorer((state) => state.path);
  const platform = useExplorer((state) => state.system?.platform ?? "win32");
  const error = useExplorer((state) => state.error);
  const online = useExplorer((state) => state.online);
  const folderSizes = useExplorer((state) => state.folderSizes);
  const tasks = useExplorer((state) => state.tasks);
  const toggleOperations = useExplorer((state) => state.toggleOperations);
  const operationsOpen = useExplorer((state) => state.operationsOpen);
  const taskSpeeds = useExplorer((state) => state.taskSpeeds);

  const count = query.trim() ? results?.length ?? 0 : entries.length;

  const currentDrive = useMemo(
    () =>
      drives
        .filter((drive) => startsWithPath(path, drive.path, platform))
        .sort((a, b) => b.path.length - a.path.length)[0],
    [drives, path, platform],
  );

  const selection = useMemo(() => {
    if (selected.length === 0) return null;

    const source = query.trim() && results ? results : entries;
    const picked = new Set(selected);
    let bytes = 0;
    let folders = 0;
    let files = 0;
    let unknown = false;

    for (const entry of source) {
      if (!picked.has(entry.path)) continue;
      if (entry.kind === "directory") {
        folders += 1;
        const size = folderSizes[entry.path];
        if (size) bytes += size.size;
        else unknown = true;
      } else {
        files += 1;
        bytes += entry.size;
      }
    }

    return { bytes, folders, files, unknown };
  }, [entries, folderSizes, query, results, selected]);

  const runningTask = useMemo(
    () =>
      Object.values(tasks).find(
        (task) => task.status === "running" || task.status === "queued",
      ),
    [tasks],
  );

  const summaryParts: string[] = [];
  if (selection) {
    if (selection.files > 0) summaryParts.push(`${selection.files} 个文件`);
    if (selection.folders > 0) summaryParts.push(`${selection.folders} 个文件夹`);
    if (selection.bytes > 0 || !selection.unknown) {
      summaryParts.push(
        `${selection.unknown ? "≥ " : ""}共 ${formatBytes(selection.bytes)}`,
      );
    }
  }

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-mac-line bg-mac-chrome/60 px-4 text-[11px] text-mac-muted backdrop-blur-xl">
      <span>
        {selected.length > 0
          ? `${selected.length} 个项目已选择`
          : `${count} 个项目`}
      </span>

      {summaryParts.length > 0 && (
        <span className="truncate">· {summaryParts.join(" · ")}</span>
      )}

      {Object.keys(tasks).length > 0 && (
        <button
          type="button"
          onClick={toggleOperations}
          aria-expanded={operationsOpen}
          className={clsx(
            "flex items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 transition-colors",
            operationsOpen
              ? "bg-black/[0.07] text-mac-text dark:bg-white/12"
              : "hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/10",
          )}
        >
          <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M8 4.5V8l2.5 1.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span>任务 {Object.keys(tasks).length}</span>
          {taskSpeeds[Object.keys(tasks)[0] ?? ""] > 0 && runningTask && (
            <span className="tabular-nums">
              {formatBytes(taskSpeeds[runningTask.id] ?? 0)}/s
            </span>
          )}
        </button>
      )}

      {runningTask && (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="text-mac-text">
            {runningTask.kind === "copy" ? "正在复制" : "正在移动"}{" "}
            {runningTask.done}/{runningTask.total}
          </span>
          {(runningTask.bytesTotal ?? 0) > 0 && (
            <span className="tabular-nums">
              {formatBytes(runningTask.bytesDone ?? 0)} /{" "}
              {formatBytes(runningTask.bytesTotal ?? 0)}
            </span>
          )}
          {runningTask.current && (
            <span className="max-w-[180px] truncate">{runningTask.current}</span>
          )}
          <button
            type="button"
            aria-label="取消操作"
            onClick={() => void api.cancelTask(runningTask.id)}
            className="grid size-3.5 place-items-center rounded-full bg-black/[0.08] hover:bg-black/[0.14] dark:bg-white/15 dark:hover:bg-white/25"
          >
            <SFXmark size={8} />
          </button>
        </span>
      )}

      {searching && (
        <span className="tabular-nums">
          搜索中…{searchScanned > 0 ? ` 已扫描 ${searchScanned} 项` : ""}
        </span>
      )}
      {!searching && query.trim() && searchTruncated && (
        <span className="text-[#ff9f0a]">
          {searchTimedOut ? "搜索超时，结果可能不完整" : "结果已截断"}
        </span>
      )}

      <span className="ml-auto flex items-center gap-2">
        {online === null ? (
          <>
            <span className="size-1.5 animate-pulse rounded-full bg-[#ff9f0a]" />
            <span>正在连接本地服务…</span>
          </>
        ) : online ? (
          <>
            <span className="size-1.5 rounded-full bg-[#34c759]" />
            <span>本地服务</span>
          </>
        ) : (
          <>
            <span className="size-1.5 rounded-full bg-[#ff453a]" />
            <span title={error ?? undefined}>服务未连接</span>
          </>
        )}
        {currentDrive && currentDrive.total > 0 && (
          <span className="border-l border-mac-line pl-2">
            可用 {formatBytes(currentDrive.free)}
          </span>
        )}
      </span>
    </footer>
  );
}
