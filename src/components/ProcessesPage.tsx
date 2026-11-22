import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SFArrowClockwise,
  SFCpu,
  SFMagnifyingglass,
  SFXmark,
} from "sf-symbols-lib/dualtone";
import { ChevronDown, ChevronUp, FolderOpen, Power } from "lucide-react";
import { clsx } from "clsx";
import type { ProcessEntryDto } from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { api, errorMessage } from "../lib/api";
import { formatBytes } from "../lib/format";
import { SettingsSwitch } from "./settings/shared";

type SortKey = "name" | "pid" | "memory" | "cpu" | "threads";

function timeLabel(value: number | null): string {
  if (!value) return "尚未刷新";
  return new Date(value).toLocaleTimeString();
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
        "flex items-center gap-0.5 font-medium transition-colors hover:text-mac-text",
        align === "right" && "ml-auto",
      )}
    >
      {label}
      {active ? (
        direction === "asc" ? (
          <ChevronUp className="size-3" />
        ) : (
          <ChevronDown className="size-3" />
        )
      ) : null}
    </button>
  );
}

/**
 * Standalone process manager: Toolhelp enumeration with memory, CPU time,
 * thread count, parent pid and a best-effort command line. Killing goes through
 * the same guard rails as the port page.
 */
export function ProcessesPage() {
  const notify = useExplorer((state) => state.notify);

  const [items, setItems] = useState<ProcessEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [cpu, setCpu] = useState<Record<number, number>>({});
  const [sortKey, setSortKey] = useState<SortKey>("memory");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [auto, setAuto] = useState(true);
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);

  const mounted = useRef(true);
  const samples = useRef(new Map<number, { cpuMs: number; at: number }>());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await api.processes();
      if (!mounted.current) return;

      const now = performance.now();
      const cores = Math.max(1, navigator.hardwareConcurrency || 1);
      const next: Record<number, number> = {};
      const seen = new Map<number, { cpuMs: number; at: number }>();
      for (const item of response.items) {
        const previous = samples.current.get(item.pid);
        if (previous) {
          const wall = now - previous.at;
          const delta = item.cpuMs - previous.cpuMs;
          if (wall > 200 && delta >= 0) {
            next[item.pid] = Math.min(100, (delta / wall / cores) * 100);
          }
        }
        seen.set(item.pid, { cpuMs: item.cpuMs, at: now });
      }
      samples.current = seen;

      setItems(response.items);
      setCpu(next);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      if (mounted.current && !silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A process manager without a live view is a static snapshot; keep it moving
  // unless the user paused it.
  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => void load(true), 3000);
    return () => window.clearInterval(timer);
  }, [auto, load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? items.filter((item) =>
          [
            item.name,
            String(item.pid),
            String(item.ppid),
            item.path ?? "",
            item.cmdline ?? "",
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        )
      : items;

    const direction = sortDir === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      switch (sortKey) {
        case "name":
          return a.name.localeCompare(b.name) * direction;
        case "pid":
          return (a.pid - b.pid) * direction;
        case "threads":
          return (a.threads - b.threads) * direction;
        case "cpu":
          return ((cpu[a.pid] ?? 0) - (cpu[b.pid] ?? 0)) * direction;
        default:
          return (a.memory - b.memory) * direction;
      }
    });
  }, [items, query, sortKey, sortDir, cpu]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const totalMemory = useMemo(
    () => items.reduce((sum, item) => sum + item.memory, 0),
    [items],
  );

  const reveal = async (item: ProcessEntryDto) => {
    if (!item.path) {
      notify("这个进程没有可打开的位置");
      return;
    }
    try {
      await api.reveal(item.path);
    } catch (cause) {
      notify(errorMessage(cause));
    }
  };

  const kill = async (item: ProcessEntryDto) => {
    setBusyPid(item.pid);
    try {
      await api.killProcess(item.pid);
      notify(`已结束 ${item.name}（PID ${item.pid}）`);
      setConfirmPid(null);
      await load(true);
    } catch (cause) {
      notify(errorMessage(cause));
    } finally {
      if (mounted.current) setBusyPid(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-mac-surface">
      <div className="mx-auto w-full max-w-[1040px] px-8 pb-12 pt-7">
        <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-mac-text">
              进程管理器
            </h1>
            <p className="mt-1 text-[12px] leading-5 text-mac-muted">
              本机全部进程的内存、CPU 与路径。结束进程会连同子进程一起关闭。
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <SettingsSwitch label="自动刷新" selected={auto} onChange={setAuto} />
            <span className="text-[11.5px] text-mac-muted">自动刷新</span>
            <button
              type="button"
              disabled={loading}
              onClick={() => void load()}
              className="flex h-7 items-center gap-1.5 rounded-[6px] bg-mac-surface px-2.5 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] disabled:opacity-45 dark:hover:bg-white/[0.08]"
            >
              <SFArrowClockwise
                size={13}
                className={loading ? "animate-spin" : undefined}
              />
              刷新
            </button>
          </div>
        </header>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex h-8 min-w-[240px] flex-1 items-center gap-1.5 rounded-[7px] bg-mac-surface px-2.5 shadow-[0_0_0_1px_var(--color-mac-line)] focus-within:ring-2 focus-within:ring-mac-blue/35">
            <SFMagnifyingglass size={13} className="shrink-0 text-mac-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按名称、PID、路径或命令行搜索"
              aria-label="搜索进程"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-mac-text outline-none placeholder:text-mac-muted"
            />
            {query && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
                className="grid size-4 shrink-0 place-items-center rounded-full text-mac-muted transition-colors hover:bg-black/[0.07] hover:text-mac-text dark:hover:bg-white/10"
              >
                <SFXmark size={8} />
              </button>
            )}
          </div>
          <span className="text-[11px] tabular-nums text-mac-muted">
            {filtered.length} / {items.length} 个进程 · 内存合计{" "}
            {formatBytes(totalMemory)} · 最近更新 {timeLabel(updatedAt)}
          </span>
        </div>

        <div className="overflow-hidden rounded-[10px] border border-mac-line bg-mac-chrome">
          {error && !loading ? (
            <div className="px-4 py-6 text-[12px] leading-5 text-[#ff9f0a]">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-10 text-[12px] text-mac-muted">
              <SFCpu size={15} className="text-mac-muted" />
              {loading
                ? "正在读取进程…"
                : items.length === 0
                  ? "没有拿到进程列表"
                  : "没有匹配的进程"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-mac-line bg-black/[0.025] text-left text-[11px] text-mac-muted dark:bg-white/[0.03]">
                    <th className="py-2 pl-3 pr-2">
                      <SortHeader
                        label="名称"
                        active={sortKey === "name"}
                        direction={sortDir}
                        onClick={() => toggleSort("name")}
                      />
                    </th>
                    <th className="px-2 py-2">
                      <SortHeader
                        label="PID"
                        active={sortKey === "pid"}
                        direction={sortDir}
                        onClick={() => toggleSort("pid")}
                      />
                    </th>
                    <th className="px-2 py-2">
                      <SortHeader
                        label="CPU"
                        active={sortKey === "cpu"}
                        direction={sortDir}
                        onClick={() => toggleSort("cpu")}
                      />
                    </th>
                    <th className="px-2 py-2">
                      <SortHeader
                        label="内存"
                        active={sortKey === "memory"}
                        direction={sortDir}
                        onClick={() => toggleSort("memory")}
                      />
                    </th>
                    <th className="px-2 py-2">
                      <SortHeader
                        label="线程"
                        active={sortKey === "threads"}
                        direction={sortDir}
                        onClick={() => toggleSort("threads")}
                      />
                    </th>
                    <th className="py-2 pl-2 pr-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-mac-line">
                  {filtered.map((item) => {
                    const confirming = confirmPid === item.pid;
                    const busy = busyPid === item.pid;
                    const percent = cpu[item.pid] ?? 0;
                    const percentLabel = percent >= 0.05 ? percent.toFixed(1) : "0";
                    return (
                      <tr
                        key={item.pid}
                        title={item.cmdline ?? item.path ?? item.name}
                        className="align-middle transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"
                      >
                        <td className="max-w-[360px] py-2 pl-3 pr-2">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-mac-text">
                              {item.name}
                            </span>
                            {item.oriel && (
                              <span className="shrink-0 rounded-[4px] bg-mac-blue/10 px-1.5 py-0.5 text-[10px] text-mac-blue">
                                Oriel
                              </span>
                            )}
                            {item.protected && !item.oriel && (
                              <span className="shrink-0 rounded-[4px] bg-black/[0.06] px-1.5 py-0.5 text-[10px] text-mac-muted dark:bg-white/10">
                                系统
                              </span>
                            )}
                          </div>
                          {item.path && (
                            <div
                              className="truncate font-mono text-[10.5px] text-mac-muted"
                              title={item.path}
                            >
                              {item.path}
                            </div>
                          )}
                          {item.cmdline &&
                            item.cmdline !== item.path &&
                            item.cmdline !== `"${item.path}"` && (
                              <div
                                className="truncate font-mono text-[10px] text-mac-muted/65"
                                title={item.cmdline}
                              >
                                {item.cmdline}
                              </div>
                            )}
                        </td>
                        <td className="px-2 py-2 tabular-nums text-mac-muted">
                          <div className="text-mac-text">{item.pid}</div>
                          <div className="text-[10.5px]">父 {item.ppid}</div>
                        </td>
                        <td className="px-2 py-2 tabular-nums text-mac-muted">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={clsx(
                                "w-[34px] text-right",
                                percent >= 25 && "font-medium text-[#ff9f0a]",
                              )}
                            >
                              {percentLabel}%
                            </span>
                            <span className="hidden h-[3px] w-10 overflow-hidden rounded-full bg-black/[0.08] sm:block dark:bg-white/[0.12]">
                              <span
                                className={clsx(
                                  "block h-full rounded-full",
                                  percent >= 25 ? "bg-[#ff9f0a]" : "bg-mac-blue",
                                )}
                                style={{ width: `${Math.min(100, percent)}%` }}
                              />
                            </span>
                          </div>
                        </td>
                        <td className="px-2 py-2 tabular-nums text-mac-text">
                          {item.memory > 0 ? formatBytes(item.memory) : "—"}
                        </td>
                        <td className="px-2 py-2 tabular-nums text-mac-muted">
                          {item.threads}
                        </td>
                        <td className="py-2 pl-2 pr-3">
                          <div className="flex items-center justify-end gap-1">
                            {confirming ? (
                              <>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void kill(item)}
                                  className="rounded-[5px] bg-[#ff453a] px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                                >
                                  {busy ? "结束中…" : "确认结束"}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setConfirmPid(null)}
                                  className="rounded-[5px] px-2 py-1 text-[11px] text-mac-muted hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                                >
                                  取消
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void reveal(item)}
                                  disabled={!item.path}
                                  title="在资源管理器中显示"
                                  aria-label={`显示 ${item.name} 的位置`}
                                  className="grid size-6 place-items-center rounded-[5px] text-mac-muted transition-colors hover:bg-black/[0.06] hover:text-mac-text disabled:opacity-30 dark:hover:bg-white/[0.09]"
                                >
                                  <FolderOpen className="size-3.5" />
                                </button>
                                {item.protected || item.oriel ? (
                                  <span
                                    className="px-2 text-[11px] text-mac-muted"
                                    title={
                                      item.oriel
                                        ? "这是 Oriel 自己的进程"
                                        : "系统关键进程不能结束"
                                    }
                                  >
                                    受保护
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmPid(item.pid)}
                                    title={`结束 ${item.name} 及其子进程`}
                                    aria-label={`结束 ${item.name}`}
                                    className="grid size-6 place-items-center rounded-[5px] text-[#ff453a] transition-colors hover:bg-[#ff453a]/10"
                                  >
                                    <Power className="size-3.5" />
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="mt-3 px-1 text-[11px] leading-4 text-mac-muted">
          CPU 为两次采样之间的占用，已按逻辑核心数归一化；自动刷新间隔 3 秒。
          命令行需要更高级的读取权限，部分系统进程会显示为空。
        </p>
      </div>
    </div>
  );
}
