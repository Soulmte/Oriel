import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SFArrowClockwise,
  SFMagnifyingglass,
  SFNetwork,
} from "sf-symbols-lib/dualtone";
import type { PortEntryDto } from "@oriel/shared";
import { useExplorer } from "../../store/explorer";
import { api, errorMessage } from "../../lib/api";
import {
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
} from "./shared";

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
]);

export function SettingsPorts() {
  const notify = useExplorer((state) => state.notify);

  const [items, setItems] = useState<PortEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const response = await api.ports(refresh);
      if (!mounted.current) return;
      setItems(response.items);
      setError(response.note);
      setUpdatedAt(Date.now());
    } catch (cause) {
      if (!mounted.current) return;
      setError(errorMessage(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
    <>
      <SettingsPageHeader
        title="端口进程"
        detail="查看本机正在监听的端口，找到占用它的程序，必要时结束进程"
      />

      <SettingsSection title="查找">
        <SettingsRow
          title="筛选"
          detail="按端口、协议、地址、进程名或 PID 过滤"
        >
          <div className="flex h-7 items-center gap-1.5 rounded-[6px] bg-mac-surface px-2 shadow-[0_0_0_1px_var(--color-mac-line)] focus-within:ring-2 focus-within:ring-mac-blue/35">
            <SFMagnifyingglass size={12} className="shrink-0 text-mac-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="8787 或 chrome"
              aria-label="筛选端口"
              className="w-[150px] bg-transparent text-[12px] text-mac-text outline-none placeholder:text-mac-muted"
            />
            {query && (
              <button
                type="button"
                aria-label="清空筛选"
                onClick={() => setQuery("")}
                className="grid size-4 place-items-center rounded-full text-mac-muted hover:bg-black/[0.07] hover:text-mac-text dark:hover:bg-white/10"
              >
                ×
              </button>
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          title="刷新"
          detail={`最近更新：${timeLabel(updatedAt)}`}
        >
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(true)}
            className="flex h-7 items-center gap-1.5 rounded-[6px] bg-mac-surface px-2.5 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] disabled:opacity-45 dark:hover:bg-white/[0.08]"
          >
            <SFArrowClockwise
              size={13}
              className={loading ? "animate-spin" : undefined}
            />
            {loading ? "正在读取…" : "刷新"}
          </button>
        </SettingsRow>
      </SettingsSection>

      <section className="mt-6">
        <div className="mb-2 flex items-end justify-between gap-4 px-1">
          <h2 className="text-[11px] font-medium text-mac-muted">监听端口</h2>
          <span className="text-[11px] tabular-nums text-mac-muted">
            {filtered.length} / {items.length} 个端口 · {processCount} 个进程
          </span>
        </div>

        <div className="overflow-hidden rounded-[10px] border border-mac-line bg-mac-chrome">
          {error && !loading ? (
            <div className="px-4 py-6 text-[12px] leading-5 text-[#ff9f0a]">
              {error}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center gap-2 px-4 py-8 text-[12px] text-mac-muted">
              <SFNetwork size={15} className="text-mac-muted" />
              {loading
                ? "正在读取端口…"
                : items.length === 0
                  ? "没有找到监听中的端口"
                  : "没有匹配的端口"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] border-collapse text-[12px]">
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
                        <td className="max-w-[180px] px-2 py-2">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-mac-text">
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
                        <td className="py-2 pl-2 pr-3 text-right">
                          {item.oriel ? (
                            <span
                              className="text-[11px] text-mac-muted"
                              title="请到「本地服务」里重启 Oriel 的服务"
                            >
                              受保护
                            </span>
                          ) : system ? (
                            <span
                              className="text-[11px] text-mac-muted"
                              title="系统关键进程不能结束"
                            >
                              受保护
                            </span>
                          ) : confirming ? (
                            <span className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void kill(item)}
                                className="rounded-[5px] bg-[#ff453a] px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                              >
                                {busy ? "结束中…" : "结束"}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setConfirmPid(null)}
                                className="rounded-[5px] px-2 py-1 text-[11px] text-mac-muted hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                              >
                                取消
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmPid(item.pid)}
                              title={`结束 ${item.process || "该进程"}`}
                              className="rounded-[5px] px-2 py-1 text-[11px] text-[#ff453a] transition-colors hover:bg-[#ff453a]/10 disabled:cursor-default disabled:opacity-35"
                            >
                              关闭
                            </button>
                          )}
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
      </section>
    </>
  );
}
