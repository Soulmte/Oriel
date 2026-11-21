import { useMemo } from "react";
import { clsx } from "clsx";
import {
  ChevronDown,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useExplorer } from "../store/explorer";
import { formatBytes } from "../lib/format";
import type { TaskProgressDto } from "@oriel/shared";

const STATUS_LABEL: Record<TaskProgressDto["status"], string> = {
  queued: "排队中",
  running: "进行中",
  paused: "已暂停",
  done: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function progressOf(task: TaskProgressDto): number {
  if (task.bytesTotal && task.bytesTotal > 0 && typeof task.bytesDone === "number") {
    return Math.min(100, Math.max(0, (task.bytesDone / task.bytesTotal) * 100));
  }
  if (task.total > 0) return Math.min(100, Math.max(0, (task.done / task.total) * 100));
  return 0;
}

function TaskRow({ task }: { task: TaskProgressDto }) {
  const speeds = useExplorer((state) => state.taskSpeeds);
  const tasks = useExplorer((state) => state.tasks);
  const pauseTask = useExplorer((state) => state.pauseTask);
  const resumeTask = useExplorer((state) => state.resumeTask);
  const retryTask = useExplorer((state) => state.retryTask);
  const cancelTask = useExplorer((state) => state.cancelTask);

  const active = task.status === "running" || task.status === "queued" || task.status === "paused";
  const percent = progressOf(task);
  const speed = speeds[task.id] ?? 0;
  const running = Object.values(tasks).filter(
    (item) => item.status === "running" || item.status === "queued",
  ).length;

  const remaining =
    task.bytesTotal && typeof task.bytesDone === "number" && speed > 0
      ? Math.max(0, task.bytesTotal - task.bytesDone) / speed
      : null;

  return (
    <div className="flex flex-col gap-1.5 border-b border-mac-line px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="text-mac-text">
          {task.kind === "copy" ? "复制" : task.kind === "move" ? "移动" : "下载"}
        </span>
        <span className="min-w-0 flex-1 truncate text-mac-muted" title={task.current ?? ""}>
          {task.current ?? (task.created[0]?.split(/[\\/]/).pop() || "…")}
        </span>
        <span
          className={clsx(
            "shrink-0 tabular-nums",
            task.status === "failed"
              ? "text-[#ff453a]"
              : task.status === "done"
                ? "text-[#34c759]"
                : "text-mac-muted",
          )}
        >
          {STATUS_LABEL[task.status]}
        </span>
      </div>

      <div className="h-[4px] overflow-hidden rounded-full bg-black/[0.09] dark:bg-white/12">
        <div
          className={clsx(
            "h-full rounded-full transition-[width] duration-200",
            task.status === "failed" ? "bg-[#ff453a]" : "bg-mac-blue",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>

      <div className="flex items-center gap-1.5 text-[11px] tabular-nums text-mac-muted">
        <span>{Math.round(percent)}%</span>
        <span>·</span>
        <span>
          {task.done}/{task.total} 项
        </span>
        {(task.bytesTotal ?? 0) > 0 && (
          <>
            <span>·</span>
            <span>
              {formatBytes(task.bytesDone ?? 0)} / {formatBytes(task.bytesTotal ?? 0)}
            </span>
          </>
        )}
        {active && speed > 0 && (
          <>
            <span>·</span>
            <span>{formatBytes(speed)}/s</span>
          </>
        )}
        {active && remaining !== null && remaining > 0 && (
          <>
            <span>·</span>
            <span>剩余 {Math.ceil(remaining)}s</span>
          </>
        )}
        {task.error && (
          <span className="truncate text-[#ff453a]" title={task.error}>
            {task.error}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {task.status === "running" && (
            <button
              type="button"
              aria-label="暂停"
              title="暂停"
              onClick={() => void pauseTask(task.id)}
              className="grid size-5 place-items-center rounded hover:bg-black/[0.07] dark:hover:bg-white/10"
            >
              <Pause className="size-3" />
            </button>
          )}
          {task.status === "paused" && (
            <button
              type="button"
              aria-label="继续"
              title="继续"
              onClick={() => void resumeTask(task.id)}
              className="grid size-5 place-items-center rounded hover:bg-black/[0.07] dark:hover:bg-white/10"
            >
              <Play className="size-3" />
            </button>
          )}
          {active && (
            <button
              type="button"
              aria-label="取消"
              title="取消"
              onClick={() => void cancelTask(task.id)}
              className="grid size-5 place-items-center rounded hover:bg-[#ff453a]/15 hover:text-[#ff453a]"
            >
              <X className="size-3" />
            </button>
          )}
          {!active && (
            <button
              type="button"
              aria-label="重试"
              title={running > 0 ? "重试（会与原任务并行）" : "重试"}
              onClick={() => void retryTask(task.id)}
              className="grid size-5 place-items-center rounded hover:bg-black/[0.07] dark:hover:bg-white/10"
            >
              <RotateCcw className="size-3" />
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export function OperationsPanel() {
  const open = useExplorer((state) => state.operationsOpen);
  const toggle = useExplorer((state) => state.toggleOperations);
  const tasks = useExplorer((state) => state.tasks);
  const clearFinished = useExplorer((state) => state.clearFinishedTasks);

  const list = useMemo(
    () =>
      Object.values(tasks).sort((a, b) => {
        const order = (status: string) =>
          status === "running" || status === "queued" || status === "paused" ? 0 : 1;
        return order(a.status) - order(b.status);
      }),
    [tasks],
  );

  if (!open) return null;

  const finished = list.filter((task) => !["running", "queued", "paused"].includes(task.status));

  return (
    <aside className="animate-fade-in fixed bottom-8 right-3 z-[90] flex w-[360px] flex-col overflow-hidden rounded-[10px] border border-black/10 bg-[#fbfbfd]/95 shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur-2xl dark:border-white/10 dark:bg-[#2c2c2e]/95">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-mac-line pl-3 pr-1.5">
        <Loader2 className="size-3.5 text-mac-muted" />
        <span className="text-[12px] font-medium text-mac-text">操作中心</span>
        <span className="text-[11px] text-mac-muted">{list.length} 项</span>
        <span className="flex-1" />
        {finished.length > 0 && (
          <button
            type="button"
            onClick={clearFinished}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-mac-muted transition-colors hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/10"
          >
            <Trash2 className="size-3" />
            清除已完成
          </button>
        )}
        <button
          type="button"
          aria-label="收起"
          onClick={toggle}
          className="grid size-6 place-items-center rounded text-mac-muted hover:bg-black/[0.06] dark:hover:bg-white/10"
        >
          <ChevronDown className="size-3.5" />
        </button>
      </header>

      <div className="max-h-[340px] overflow-y-auto">
        {list.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-mac-muted">
            还没有复制或移动任务
          </p>
        ) : (
          list.map((task) => <TaskRow key={task.id} task={task} />)
        )}
      </div>
    </aside>
  );
}
