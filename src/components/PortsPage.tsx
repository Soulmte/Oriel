import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SFArrowClockwise,
  SFMagnifyingglass,
  SFNetwork,
  SFXmark,
} from "sf-symbols-lib/dualtone";
import { FolderOpen, Power } from "lucide-react";
import type { PortEntryDto } from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { api, errorMessage } from "../lib/api";
import { SettingsSwitch } from "./settings/shared";

function timeLabel(value: number | null): string {
  if (!value) return "尚未刷新";
  return new Date(value).toLocaleTimeString();
}

const PROTECTED_PROCESSES = new Set([
  "system",
  "registry",
  "smss",
  "csrss",
  "wininit",
  "winlogon",
  "services",
  "lsass",
  "memory compression",
  "fontdrvhost",
]);

/**
 * Listening TCP/UDP endpoints and the processes behind them. Standalone page:
 * the settings tree only holds preferences, not live system views.
 */
export function PortsPage() {
  const notify = useExplorer((state) => state.notify);

  const [items, setItems] = useState<PortEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);
  const [auto, setAuto] = useState(true);

  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await api.ports(silent);
      if (!mounted.current) return;
      setItems(response.items);
      setError(response.note);
      setUpdatedAt(Date.now());
    } catch (cause) {
      if (!mounted.current) return;
      setError(errorMessage(cause));
    } finally {
      if (mounted.current && !silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, [auto, load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [
        String(item.port),
        item.protocol,
        item.address,
        item.process,
        String(item.pid),
        item.path ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [items, query]);

  const processCount = useMemo(
    () => new Set(items.map((item) => item.pid)).size,
    [items],
  );

  const reveal = async (item: PortEntryDto) => {
    if (!item.path) {
      notify(`${item.process || "该进程"} 没有可打开的位置`);
      return;
    }
    try {
      await api.reveal(item.path);
    } catch (cause) {
      notify(errorMessage(cause));
    }
  };

  const kill = async (item: PortEntryDto) => {
    setBusyPid(item.pid);
    try {
      await api.killPortProcess(item.pid);
      notify(`已结束 ${item.process || "进程"}（PID ${item.pid}）`);
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
              端口进程
            </h1>
            <p className="mt-1 text-[12px] leading-5 text-mac-muted">
              本机正在监听的 TCP/UDP 端口，以及占用它们的程序。
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
              placeholder="按端口、协议、地址、进程名或 PID 搜索"
              aria-label="搜索端口"
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
            {filtered.length} / {items.length} 个端口 · {processCount} 个进程 ·
            最近更新 {timeLabel(updatedAt)}
          </span>
        </div>

        <div className="overflow-hidden rounded-[10px] border border-mac-line bg-mac-chrome">
          {error && !loading ? (
            <div className="px-4 py-6 text-[12px] leading-5 text-[#ff9f0a]">{error}</div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-10 text-[12px] text-mac-muted">
              <SFNetwork size={15} className="text-mac-muted" />
              {loading
                ? "正在读取端口…"
                : items.length === 0
                  ? "没有找到监听中的端口"
                  : "没有匹配的端口"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-mac-line bg-black/[0.025] text-left text-[11px] text-mac-muted dark:bg-white/[0.03]">
                    <th className="py-2 pl-3 pr-2 font-medium">端口</th>
                    <th className="px-2 py-2 font-medium">协议</th>
                    <th className="px-2 py-2 font-medium">地址</th>
                    <th className="px-2 py-2 font-medium">进程</th>
                    <th className="px-2 py-2 font-medium">PID</th>
                    <th className="py-2 pl-2 pr-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-mac-line">
                  {filtered.map((item) => {
                    const system =
                      item.pid === 0 ||
                      item.pid === 4 ||
                      PROTECTED_PROCESSES.has(item.process.toLowerCase());
                    const confirming = confirmPid === item.pid;
                    const busy = busyPid === item.pid;
                    return (
                      <tr
                        key={`${item.protocol}-${item.address}-${item.port}-${item.pid}`}
                        className="align-middle transition-colors hover:bg-black/[0.025] dark:hover:bg-white/[0.03]"
                      >
                        <td className="py-2 pl-3 pr-2 tabular-nums text-mac-text">
                          {item.port}
                        </td>
                        <td className="px-2 py-2">
                          <span className="rounded-[4px] bg-black/[0.06] px-1.5 py-0.5 text-[10.5px] text-mac-muted dark:bg-white/10">
                            {item.protocol}
                          </span>
                        </td>
                        <td className="px-2 py-2 font-mono text-[11px] text-mac-muted">
                          {item.address}
                        </td>
                        <td className="max-w-[240px] px-2 py-2">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-mac-text">
                              {item.process || "未知进程"}
                            </span>
                            {item.oriel && (
                              <span className="shrink-0 rounded-[4px] bg-mac-blue/10 px-1.5 py-0.5 text-[10px] text-mac-blue">
                                本地服务
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
                        </td>
                        <td className="px-2 py-2 tabular-nums text-mac-muted">
                          {item.pid}
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
                                  aria-label={`显示 ${item.process || "进程"} 的位置`}
                                  className="grid size-6 place-items-center rounded-[5px] text-mac-muted transition-colors hover:bg-black/[0.06] hover:text-mac-text disabled:opacity-30 dark:hover:bg-white/[0.09]"
                                >
                                  <FolderOpen className="size-3.5" />
                                </button>
                                {item.oriel ? (
                                  <span
                                    className="px-2 text-[11px] text-mac-muted"
                                    title="Oriel 自己的进程，结束会让窗口失去响应"
                                  >
                                    受保护
                                  </span>
                                ) : system ? (
                                  <span
                                    className="px-2 text-[11px] text-mac-muted"
                                    title="系统关键进程不能结束"
                                  >
                                    受保护
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmPid(item.pid)}
                                    title={`结束 ${item.process || "该进程"} 及其子进程`}
                                    aria-label={`结束 ${item.process || "该进程"}`}
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
          结束进程会立即关闭对应程序，未保存的内容可能丢失。
          标记为「本地服务」的是 Oriel 自己的进程，不会被这里结束。
        </p>
      </div>
    </div>
  );
}
