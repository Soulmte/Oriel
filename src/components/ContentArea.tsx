import type { ReactNode } from "react";
import {
  SFExclamationmarkTriangleFill,
  SFFolderFill,
  SFMagnifyingglass,
} from "sf-symbols-lib/dualtone";
import { Button, Spinner } from "@heroui/react";
import { useExplorer } from "../store/explorer";
import { FileGrid } from "./FileGrid";
import { FileList } from "./FileList";

function SkeletonGrid() {
  return (
    <div className="h-full overflow-hidden px-5 py-4">
      <div className="grid grid-cols-[repeat(auto-fill,104px)] justify-start gap-x-2 gap-y-4">
        {Array.from({ length: 24 }).map((_, index) => (
          <div key={index} className="flex flex-col items-center gap-2">
            <div className="size-12 animate-pulse rounded-lg bg-black/[0.06] dark:bg-white/[0.08]" />
            <div className="h-2 w-12 animate-pulse rounded-full bg-black/[0.06] dark:bg-white/[0.08]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function CenteredState({
  icon,
  title,
  detail,
  action,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <div className="grid size-14 place-items-center rounded-2xl bg-black/[0.04] text-mac-muted dark:bg-white/[0.06]">
          {icon}
        </div>
        <div className="text-[14px] font-medium text-mac-text">{title}</div>
        {detail && (
          <div className="text-[12px] leading-5 text-mac-muted">{detail}</div>
        )}
        {action}
      </div>
    </div>
  );
}

export function ContentArea() {
  const ready = useExplorer((state) => state.ready);
  const loading = useExplorer((state) => state.loading);
  const error = useExplorer((state) => state.error);
  const entries = useExplorer((state) => state.entries);
  const view = useExplorer((state) => state.view);
  const query = useExplorer((state) => state.query);
  const results = useExplorer((state) => state.results);
  const searching = useExplorer((state) => state.searching);
  const searchTruncated = useExplorer((state) => state.searchTruncated);
  const searchScanned = useExplorer((state) => state.searchScanned);
  const searchTimedOut = useExplorer((state) => state.searchTimedOut);
  const stopSearch = useExplorer((state) => state.stopSearch);
  const reload = useExplorer((state) => state.reload);
  const path = useExplorer((state) => state.path);
  const dragging = useExplorer((state) => state.dragging);
  const frozenEntries = useExplorer((state) => state.frozenEntries);
  const frozenPath = useExplorer((state) => state.frozenPath);

  // Hover-navigation during a drag swaps the folder under the pointer. The
  // listing that owns the dragged tile has to stay in the document or the
  // browser cancels the drag, so it is parked off-screen until the drag ends.
  const frozen = dragging && frozenEntries !== null && frozenPath !== path;

  if ((!ready || loading) && entries.length === 0 && !error) {
    return (
      <div className="min-h-0 flex-1 bg-mac-surface">
        <SkeletonGrid />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-0 flex-1 bg-mac-surface">
        <CenteredState
          icon={<SFExclamationmarkTriangleFill size={24} className="text-[#ff9f0a]" />}
          title="无法打开此位置"
          detail={error}
          action={
            <Button size="sm" variant="secondary" onPress={reload}>
              重试
            </Button>
          }
        />
      </div>
    );
  }

  if (query.trim()) {
    // Streaming search: the first matches land after a few dozen milliseconds,
    // so only an empty result set shows the progress state.
    if (searching && (!results || results.length === 0)) {
      return (
        <div className="grid min-h-0 flex-1 place-items-center bg-mac-surface">
          <div className="flex flex-col items-center gap-2 text-[12px] tabular-nums text-mac-muted">
            <Spinner size="sm" />
            <span>
              正在搜索{searchScanned > 0 ? `，已扫描 ${searchScanned.toLocaleString()} 项` : "…"}
            </span>
            <button
              type="button"
              onClick={stopSearch}
              className="rounded-[5px] px-2 py-0.5 text-[11.5px] text-mac-muted transition-colors hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/[0.08]"
            >
              停止
            </button>
          </div>
        </div>
      );
    }

    if (!results) {
      return (
        <div className="min-h-0 flex-1 bg-mac-surface">
          <SkeletonGrid />
        </div>
      );
    }

    if (results.length === 0) {
      return (
        <div className="min-h-0 flex-1 bg-mac-surface">
          <CenteredState
            icon={<SFMagnifyingglass size={24} />}
            title={`找不到 “${query.trim()}”`}
            detail={
              searchTimedOut
                ? `已扫描 ${searchScanned.toLocaleString()} 项后超时，结果可能不完整。可以把搜索范围切到「当前文件夹」，或换个关键词再试。`
                : `已扫描 ${searchScanned.toLocaleString()} 项。请尝试其他关键词，或换一个文件夹再搜索。`
            }
          />
        </div>
      );
    }

    return (
      <div className="min-h-0 flex-1 overflow-hidden bg-mac-surface">
        <div className="flex h-7 items-center gap-2 border-b border-mac-line px-3 text-[11px] text-mac-muted">
          <span className="tabular-nums">{results.length} 个搜索结果</span>
          {searching && (
            <>
              <span className="tabular-nums">
                · 搜索中，已扫描 {searchScanned.toLocaleString()} 项
              </span>
              <button
                type="button"
                onClick={stopSearch}
                className="rounded-[4px] px-1.5 py-0.5 transition-colors hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/[0.08]"
              >
                停止
              </button>
            </>
          )}
          {!searching && searchTruncated && (
            <span className="text-[#ff9f0a]">
              {searchTimedOut
                ? `· 已扫描 ${searchScanned.toLocaleString()} 项后超时，结果可能不完整`
                : "· 结果已截断"}
            </span>
          )}
        </div>
        {view === "grid" ? (
          <FileGrid entries={results} />
        ) : (
          <FileList entries={results} />
        )}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="min-h-0 flex-1 bg-mac-surface">
        <CenteredState
          icon={<SFFolderFill size={24} />}
          title="文件夹为空"
          detail="这里还没有内容。按 Ctrl+Shift+N 新建一个文件夹。"
        />
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-mac-surface">
      <div className="h-full">
        {view === "grid" ? (
          <FileGrid entries={frozenEntries ?? entries} />
        ) : (
          <FileList entries={frozenEntries ?? entries} />
        )}
      </div>

      {frozen && (
        <div className="absolute inset-0 bg-mac-surface">
          {view === "grid" ? <FileGrid entries={entries} /> : <FileList entries={entries} />}
        </div>
      )}
    </div>
  );
}
