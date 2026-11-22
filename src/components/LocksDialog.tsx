import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, Spinner } from "@heroui/react";
import { SFArrowClockwise, SFLock } from "sf-symbols-lib/dualtone";
import { FolderOpen } from "lucide-react";
import type { LockEntryDto, LockListResponse } from "@oriel/shared";
import { api, errorMessage } from "../lib/api";
import { useExplorer } from "../store/explorer";
import { basename } from "../lib/format";

const HEADER = "justify-start px-5 pb-0 pt-5";
const BODY = "px-5 pb-0 pt-3";
const FOOTER = "flex-nowrap justify-end gap-2 px-5 pb-4 pt-5";
const BUTTON = "h-7 min-w-[72px] rounded-[6px] px-3 text-[12.5px] font-normal";
const PRIMARY = `${BUTTON} bg-mac-blue text-white data-[hovered=true]:bg-mac-blue/90`;
const SECONDARY = `${BUTTON} bg-mac-surface text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] data-[hovered=true]:bg-black/[0.04] dark:data-[hovered=true]:bg-white/[0.08]`;

const TYPE_LABEL: Record<string, string> = {
  window: "窗口程序",
  service: "系统服务",
  console: "控制台",
  explorer: "资源管理器",
  critical: "关键进程",
  unknown: "进程",
};

/**
 * “这个文件删不掉，谁在用？” — opened from the file context menu. Windows
 * Restart Manager lists every process holding a handle on the path, and each
 * row can be ended in place, so no separate tool page or path typing is needed.
 */
export function LocksDialog({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const notify = useExplorer((state) => state.notify);

  const [result, setResult] = useState<LockListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [busyPid, setBusyPid] = useState<number | null>(null);

  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.locks(path);
      if (!mounted.current) return;
      setResult(response);
      setConfirmPid(null);
    } catch (cause) {
      if (!mounted.current) return;
      setResult(null);
      setError(errorMessage(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void check();
  }, [check]);

  const reveal = async (item: LockEntryDto) => {
    if (!item.path) {
      notify(`${item.name} 没有可打开的位置`);
      return;
    }
    try {
      await api.reveal(item.path);
    } catch (cause) {
      notify(errorMessage(cause));
    }
  };

  const kill = async (item: LockEntryDto) => {
    setBusyPid(item.pid);
    try {
      await api.killProcess(item.pid);
      notify(`已结束 ${item.name}（PID ${item.pid}）`);
      await check();
    } catch (cause) {
      notify(errorMessage(cause));
    } finally {
      if (mounted.current) setBusyPid(null);
    }
  };

  const items = result?.items ?? [];

  return (
    <>
      <Modal.Header className={HEADER}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-[#ff9f0a]/12">
            <SFLock size={18} className="text-[#ff9f0a]" />
          </span>
          <div className="min-w-0">
            <Modal.Heading className="truncate text-left text-[14px] font-semibold text-mac-text">
              占用进程
            </Modal.Heading>
            <p
              className="mt-0.5 truncate font-mono text-[10.5px] text-mac-muted"
              title={path}
            >
              {basename(path) || path}
            </p>
          </div>
          {loading && <Spinner size="sm" className="ml-auto shrink-0" />}
        </div>
      </Modal.Header>

      <Modal.Body className={BODY}>
        {error ? (
          <p className="select-text text-[12px] leading-5 text-[#ff9f0a]">{error}</p>
        ) : loading && !result ? (
          <p className="py-6 text-center text-[12px] text-mac-muted">正在检查…</p>
        ) : items.length === 0 ? (
          <div className="rounded-[8px] bg-[#30d158]/[0.08] px-3 py-2.5">
            <p className="text-[12.5px] font-medium text-[#1f8a3b] dark:text-[#4ade80]">
              没有程序占用这个文件
            </p>
            <p className="mt-0.5 text-[11.5px] leading-4 text-mac-muted">
              如果仍然删不掉，可能是权限、只读属性或磁盘错误。
            </p>
          </div>
        ) : (
          <div className="-mx-1 max-h-[300px] overflow-y-auto px-1">
            {items.map((item) => {
              const confirming = confirmPid === item.pid;
              const busy = busyPid === item.pid;
              return (
                <div
                  key={item.pid}
                  className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.045]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-mac-text">
                        {item.name}
                      </span>
                      {item.oriel && (
                        <span className="shrink-0 rounded-[4px] bg-mac-blue/10 px-1.5 text-[10px] text-mac-blue">
                          Oriel
                        </span>
                      )}
                      {item.service && (
                        <span className="shrink-0 font-mono text-[10px] text-mac-muted">
                          {item.service}
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
                  </div>
                  <span className="shrink-0 tabular-nums text-[11px] text-mac-muted">
                    {item.pid}
                  </span>
                  <span className="shrink-0 rounded-[4px] bg-black/[0.06] px-1.5 py-0.5 text-[10px] text-mac-muted dark:bg-white/10">
                    {TYPE_LABEL[item.appType] ?? "进程"}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
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
                    {confirming ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void kill(item)}
                          className="rounded-[5px] bg-[#ff453a] px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {busy ? "结束中…" : "确认"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setConfirmPid(null)}
                          className="rounded-[5px] px-1.5 py-1 text-[11px] text-mac-muted hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                        >
                          取消
                        </button>
                      </>
                    ) : item.protected || item.oriel ? (
                      <span
                        className="px-1.5 text-[11px] text-mac-muted"
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
                        title={`结束 ${item.name}，然后这个文件就可以删除了`}
                        className="rounded-[5px] px-1.5 py-1 text-[11px] text-[#ff453a] transition-colors hover:bg-[#ff453a]/10"
                      >
                        结束
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Modal.Body>

      <Modal.Footer className={FOOTER}>
        <Button
          className={SECONDARY}
          isDisabled={loading}
          onPress={() => void check()}
        >
          <SFArrowClockwise size={13} />
          <span className="ml-1">重新检查</span>
        </Button>
        <Button className={PRIMARY} onPress={onClose}>
          完成
        </Button>
      </Modal.Footer>
    </>
  );
}
