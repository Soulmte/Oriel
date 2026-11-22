import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Spinner } from "@heroui/react";
import {
  SFAppGrid,
  SFArrowClockwise,
  SFArrowDown,
  SFArrowUp,
  SFCheckmarkCircleFill,
  SFCheckmarkSealFill,
  SFExclamationmarkTriangleFill,
  SFMagnifyingglass,
  SFXmarkBinFill,
} from "sf-symbols-lib/dualtone";
import { FolderOpen, Lock, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import type {
  InstalledAppDto,
  LeftoverCleanResultDto,
  LeftoverItemDto,
  LeftoverReportDto,
} from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { api, errorMessage } from "../lib/api";
import { formatBytes } from "../lib/format";
import { relaunchElevated } from "../lib/system";

type Busy = "uninstall" | "scan" | "clean" | null;
type AppSort = "name" | "size" | "installed";

const APP_SORTS: Array<{ key: AppSort; label: string; direction: "asc" | "desc" }> = [
  { key: "name", label: "名称", direction: "asc" },
  { key: "size", label: "大小", direction: "desc" },
  { key: "installed", label: "安装时间", direction: "desc" },
];

const NAME_COLLATOR = new Intl.Collator("zh-CN", {
  numeric: true,
  sensitivity: "base",
});

/** Measured size when available, otherwise the registry estimate. */
function sizeOf(app: InstalledAppDto): number {
  return app.size > 0 ? app.size : app.estimatedSize;
}

function sizeLabel(app: InstalledAppDto): string {
  const value = sizeOf(app);
  if (value <= 0) return "—";
  return `${app.sizeMeasured ? "" : "≈"}${formatBytes(value)}`;
}

function AppIcon({
  app,
  icons,
  size = 28,
}: {
  app: InstalledAppDto;
  icons: Record<string, string | null>;
  size?: number;
}) {
  const source = app.iconPath ? icons[app.iconPath] : null;
  if (source) {
    return (
      <img
        src={source}
        alt=""
        width={size}
        height={size}
        draggable={false}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-[6px] object-contain"
      />
    );
  }
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[6px] bg-black/[0.06] dark:bg-white/[0.08]"
      style={{ width: size, height: size }}
    >
      <SFAppGrid size={Math.round(size * 0.6)} className="text-mac-muted" />
    </span>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-mac-muted">{label}</dt>
      <dd
        className={clsx(
          "break-all text-[11px] leading-4 text-mac-text",
          mono && "font-mono text-[10.5px]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function LeftoverGroup({
  title,
  items,
  checked,
  onToggle,
}: {
  title: string;
  items: LeftoverItemDto[];
  checked: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="mb-2 last:mb-0">
      <p className="px-2 pb-1 pt-2 text-[10px] font-semibold tracking-[0.04em] text-mac-muted">
        {title}
      </p>
      {items.map((item) => (
        <label
          key={item.id}
          className="flex cursor-default items-start gap-2.5 rounded-[6px] px-2 py-1.5 transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <input
            type="checkbox"
            checked={checked.has(item.id)}
            onChange={() => onToggle(item.id)}
            className="mt-0.5 size-3.5 shrink-0 accent-[#0a84ff]"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5 text-[12px] text-mac-text">
              <span className="truncate">{item.label}</span>
              {item.needsAdmin && (
                <Lock
                  size={10}
                  aria-label="需要管理员权限"
                  className="shrink-0 text-[#a86a00] dark:text-[#ffb340]"
                />
              )}
              {item.risk === "caution" && (
                <span className="shrink-0 rounded-[3px] bg-[#ff9f0a]/15 px-1 py-px text-[9px] text-[#a86a00] dark:text-[#ffb340]">
                  可能与其他程序共用
                </span>
              )}
              {item.partial && (
                <span className="shrink-0 text-[9.5px] text-mac-muted">未完全统计</span>
              )}
            </span>
            <span
              className="mt-0.5 block truncate font-mono text-[10px] leading-4 text-mac-muted"
              title={item.detail}
            >
              {item.detail}
            </span>
          </span>
          <span className="shrink-0 pt-0.5 text-[10.5px] tabular-nums text-mac-muted">
            {item.size > 0 ? formatBytes(item.size) : "—"}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * Geek-style uninstaller: run the program's own wizard, wait for it to exit,
 * then show what it forgot in a dialog. Every deletable item comes from the
 * server's own candidate list, so the UI never sends a path of its choosing.
 */
export function UninstallerPage() {
  const notify = useExplorer((state) => state.notify);
  const go = useExplorer((state) => state.go);

  const [apps, setApps] = useState<InstalledAppDto[]>([]);
  const [icons, setIcons] = useState<Record<string, string | null>>({});
  const [elevated, setElevated] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<AppSort>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [sizing, setSizing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Kept apart from the inventory so the page still knows the app after its
  // uninstall entry disappears from the list.
  const [selectedApp, setSelectedApp] = useState<InstalledAppDto | null>(null);

  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waitingPid, setWaitingPid] = useState<number | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [leftovers, setLeftovers] = useState<LeftoverReportDto | null>(null);
  const [leftoverOpen, setLeftoverOpen] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<LeftoverCleanResultDto | null>(null);

  const mounted = useRef(true);
  const waitToken = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      waitToken.current += 1;
    };
  }, []);

  const loadSizes = useCallback(async (items: InstalledAppDto[]) => {
    if (items.length === 0) return;
    setSizing(true);
    try {
      // Small batches keep the first results visible while the big folders are
      // still walking, and avoid four size workers per batch overwhelming the
      // disk along with the rest of the app.
      for (let start = 0; start < items.length; start += 24) {
        if (!mounted.current) return;
        const chunk = items.slice(start, start + 24);
        try {
          const { sizes } = await api.appSizes(chunk.map((item) => item.id));
          if (!mounted.current) return;
          const apply = (app: InstalledAppDto): InstalledAppDto => {
            const info = sizes[app.id];
            return info
              ? {
                  ...app,
                  size: info.size,
                  sizePartial: info.partial,
                  sizeMeasured: info.measured,
                }
              : app;
          };
          setApps((current) => current.map(apply));
          setSelectedApp((current) => (current ? apply(current) : current));
        } catch {
          // Keep the registry estimate; the next refresh retries.
        }
      }
    } finally {
      if (mounted.current) setSizing(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.apps();
      if (!mounted.current) return;
      setApps(data.items);
      setElevated(data.elevated);
      setSelectedApp((current) =>
        current
          ? data.items.find((app) => app.id === current.id) ?? current
          : null,
      );
      void loadSizes(data.items);
    } catch (cause) {
      if (!mounted.current) return;
      setLoadError(errorMessage(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [loadSizes]);

  useEffect(() => {
    void load();
  }, [load]);

  // Icon extraction is capped at 120 paths per request; chunk the inventory.
  useEffect(() => {
    const paths = Array.from(
      new Set(apps.map((app) => app.iconPath).filter((path) => Boolean(path))),
    );
    if (paths.length === 0) return;
    let cancelled = false;
    void (async () => {
      const merged: Record<string, string | null> = {};
      for (let index = 0; index < paths.length; index += 120) {
        try {
          const data = await api.icons(paths.slice(index, index + 120));
          Object.assign(merged, data.icons);
        } catch {
          break;
        }
      }
      if (!cancelled) setIcons(merged);
    })();
    return () => {
      cancelled = true;
    };
  }, [apps]);

  const selected = selectedApp;
  const inInventory = selected
    ? apps.some((app) => app.id === selected.id)
    : false;

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return apps;
    return apps.filter(
      (app) =>
        app.name.toLowerCase().includes(text) ||
        app.publisher.toLowerCase().includes(text) ||
        app.installLocation.toLowerCase().includes(text),
    );
  }, [apps, query]);

  const sorted = useMemo(() => {
    const items = [...filtered];
    const factor = sortDir === "asc" ? 1 : -1;
    items.sort((left, right) => {
      if (sortKey === "size") {
        const diff = sizeOf(left) - sizeOf(right);
        if (diff !== 0) return diff * factor;
        return NAME_COLLATOR.compare(left.name, right.name);
      }
      if (sortKey === "installed") {
        // Empty install dates always go last, whichever direction is active.
        if (!left.installDate && !right.installDate) {
          return NAME_COLLATOR.compare(left.name, right.name);
        }
        if (!left.installDate) return 1;
        if (!right.installDate) return -1;
        const diff = left.installDate.localeCompare(right.installDate);
        if (diff !== 0) return diff * factor;
        return NAME_COLLATOR.compare(left.name, right.name);
      }
      return NAME_COLLATOR.compare(left.name, right.name) * factor;
    });
    return items;
  }, [filtered, sortKey, sortDir]);

  const chooseSort = (key: AppSort) => {
    if (key === sortKey) {
      setSortDir((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    setSortDir(key === "name" ? "asc" : "desc");
  };

  const registryItems = useMemo(
    () => (leftovers?.items ?? []).filter((item) => item.kind === "registry"),
    [leftovers],
  );
  const fileItems = useMemo(
    () => (leftovers?.items ?? []).filter((item) => item.kind !== "registry"),
    [leftovers],
  );

  const checkedItems = useMemo(
    () => (leftovers?.items ?? []).filter((item) => checked.has(item.id)),
    [leftovers, checked],
  );
  const checkedSize = useMemo(
    () => checkedItems.reduce((sum, item) => sum + item.size, 0),
    [checkedItems],
  );
  const adminSelected = useMemo(
    () => checkedItems.filter((item) => item.needsAdmin).length,
    [checkedItems],
  );
  const cautionSelected = useMemo(
    () => checkedItems.filter((item) => item.risk === "caution").length,
    [checkedItems],
  );
  const allChecked =
    Boolean(leftovers) &&
    leftovers!.items.length > 0 &&
    leftovers!.items.every((item) => checked.has(item.id));

  const failures = useMemo(
    () =>
      (result?.items ?? [])
        .filter((item) => !item.ok)
        .map((item) => `${item.label}：${item.error ?? "删除失败"}`),
    [result],
  );

  useEffect(() => {
    setLeftovers(null);
    setChecked(new Set());
    setConfirming(false);
    setNotice(null);
    setScanError(null);
  }, [selectedId]);

  // Escape closes the inline confirmation instead of the dialog or the page.
  useEffect(() => {
    if (!confirming) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setConfirming(false);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [confirming]);

  const toggle = (id: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!leftovers) return;
    setChecked(
      allChecked ? new Set() : new Set(leftovers.items.map((item) => item.id)),
    );
  };

  const performScan = useCallback(
    async (app: InstalledAppDto, open: boolean) => {
      setScanError(null);
      setConfirming(false);
      setResult(null);
      try {
        const report = await api.appLeftovers(app.id);
        if (!mounted.current) return;
        setLeftovers(report);
        setChecked(
          new Set(
            report.items
              .filter((item) => item.risk === "safe")
              .map((item) => item.id),
          ),
        );
        if (open) setLeftoverOpen(true);
        notify(
          report.items.length > 0
            ? `发现 ${report.items.length} 项卸载残留`
            : "没有发现卸载残留",
        );
      } catch (cause) {
        if (!mounted.current) return;
        setScanError(errorMessage(cause));
        if (open) setLeftoverOpen(true);
      }
    },
    [notify],
  );

  const scan = async () => {
    if (!selected || busy) return;
    setBusy("scan");
    try {
      await performScan(selected, true);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const waitForExit = async (
    pid: number,
  ): Promise<"stopped" | "unknown" | "cancelled"> => {
    const token = ++waitToken.current;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!mounted.current || token !== waitToken.current) return "cancelled";
      try {
        const { running } = await api.appUninstallStatus(pid);
        if (running === false) return "stopped";
        if (running === null) return "unknown";
      } catch {
        return "unknown";
      }
    }
    return "cancelled";
  };

  const skipWait = () => {
    waitToken.current += 1;
    setWaitingPid(null);
    setNotice(null);
    if (selected) void performScan(selected, true);
  };

  const uninstall = async (quiet: boolean) => {
    if (!selected || busy || waitingPid !== null) return;
    setBusy("uninstall");
    setNotice(null);
    try {
      const started = Date.now();
      const { pid } = await api.uninstallApp(selected.id, quiet);
      if (!mounted.current) return;
      setBusy(null);

      if (pid) {
        setWaitingPid(pid);
        setNotice("卸载程序已启动，退出向导后会自动刷新列表并扫描残留。");
        const finished = await waitForExit(pid);
        if (!mounted.current) return;
        setWaitingPid(null);
        if (finished === "unknown") {
          await load();
          setNotice(
            "无法确认卸载程序是否结束（它可能已提权运行）。完成向导后点「扫描卸载残留」。",
          );
        } else if (finished === "stopped") {
          await load();
          // Some uninstall strings hand off to a launcher that exits at once
          // (Store app aliases, elevated relaunches). Scanning then would
          // inspect files the wizard is still using, so only the manual path
          // stays available for those.
          if (quiet || Date.now() - started > 2500) {
            setNotice(null);
            await performScan(selected, true);
          } else {
            setNotice(
              "卸载程序已交给系统启动。完成向导后点「扫描卸载残留」检查剩余文件。",
            );
          }
        }
      } else {
        setNotice("卸载程序已启动。完成卸载向导后点「扫描卸载残留」。");
      }
      notify(quiet ? "已启动静默卸载" : "已启动卸载程序");
    } catch (cause) {
      if (mounted.current) setNotice(errorMessage(cause));
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const clean = async () => {
    if (!selected || !leftovers || busy) return;
    const registry = checkedItems
      .filter((item) => item.kind === "registry")
      .map((item) => item.id);
    const paths = checkedItems
      .filter((item) => item.kind !== "registry")
      .map((item) => item.id);
    if (registry.length + paths.length === 0) return;

    setBusy("clean");
    try {
      const data = await api.cleanAppLeftovers(selected.id, registry, paths);
      if (!mounted.current) return;
      setResult(data);
      setConfirming(false);
      setLeftovers(null);
      setChecked(new Set());
      notify(
        data.failed > 0
          ? `已清理 ${data.deleted} 个文件，${data.failed} 项失败`
          : data.freed > 0
            ? `已释放 ${formatBytes(data.freed)}`
            : "残留已清理",
      );
      await load();
    } catch (cause) {
      if (!mounted.current) return;
      setScanError(errorMessage(cause));
      setConfirming(false);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const closeLeftovers = () => {
    setLeftoverOpen(false);
    setConfirming(false);
    setResult(null);
    setLeftovers(null);
    setScanError(null);
    setChecked(new Set());
  };

  const elevate = async () => {
    try {
      await relaunchElevated();
    } catch (cause) {
      notify(errorMessage(cause));
    }
  };

  const primaryButton =
    "flex h-8 items-center justify-center gap-1.5 rounded-[7px] bg-mac-blue px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45";
  const secondaryButton =
    "flex h-8 items-center justify-center gap-1.5 rounded-[7px] bg-mac-surface px-3 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] disabled:opacity-45 dark:hover:bg-white/[0.08]";
  const dangerButton =
    "flex h-8 items-center justify-center gap-1.5 rounded-[7px] bg-[#ff453a] px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-45";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-mac-surface">
      <div className="mx-auto w-full max-w-[1180px] px-5 pb-14 pt-7">
        <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-mac-text">
              卸载工具
            </h1>
            <p className="mt-1 text-[12px] leading-5 text-mac-muted">
              运行程序自带的卸载向导，结束后自动刷新列表并弹窗列出残留的注册表项、安装目录和缓存，勾选后永久删除。
            </p>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void load()}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] bg-mac-surface px-2.5 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] disabled:opacity-45 dark:hover:bg-white/[0.08]"
          >
            <SFArrowClockwise size={13} className={loading ? "animate-spin" : undefined} />
            {loading ? "读取中…" : "重新读取"}
          </button>
        </header>

        {!elevated && (
          <div className="mb-3 flex items-start gap-2 rounded-[8px] border border-[#ff9f0a]/35 bg-[#ff9f0a]/[0.07] px-3 py-2 text-[11.5px] leading-5 text-[#a86a00] dark:text-[#ffb340]">
            <SFExclamationmarkTriangleFill size={13} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p>
                当前未以管理员身份运行。用户级残留（HKCU、AppData、桌面/开始菜单快捷方式）可以正常清理；
                HKLM 注册表和 Program Files 里的系统级残留需要管理员权限。
              </p>
              <button
                type="button"
                onClick={() => void elevate()}
                className="mt-1 font-medium underline underline-offset-2 hover:no-underline"
              >
                以管理员身份重启 Oriel
              </button>
            </div>
          </div>
        )}

        {loadError && (
          <div className="mb-3 rounded-[8px] border border-[#ff9f0a]/35 bg-[#ff9f0a]/[0.07] px-3 py-2 text-[11.5px] leading-5 text-[#a86a00] dark:text-[#ffb340]">
            {loadError}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section className="flex min-w-0 flex-col overflow-hidden rounded-[10px] border border-mac-line bg-mac-chrome">
            <div className="flex items-center gap-2 border-b border-mac-line px-3 py-2">
              <SFMagnifyingglass size={13} className="shrink-0 text-mac-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索名称、发布者或安装位置"
                aria-label="搜索已安装程序"
                spellCheck={false}
                className="h-6 min-w-0 flex-1 bg-transparent text-[12px] text-mac-text outline-none placeholder:text-mac-muted"
              />
              <span className="shrink-0 text-[10.5px] tabular-nums text-mac-muted">
                {filtered.length} / {apps.length}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1 border-b border-mac-line px-3 py-1.5">
              <span className="mr-0.5 text-[10px] text-mac-muted">排序</span>
              {APP_SORTS.map((option) => {
                const active = option.key === sortKey;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => chooseSort(option.key)}
                    aria-pressed={active}
                    className={clsx(
                      "flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[10.5px] transition-colors",
                      active
                        ? "bg-mac-blue/15 font-medium text-mac-blue"
                        : "text-mac-muted hover:bg-black/[0.04] hover:text-mac-text dark:hover:bg-white/[0.06]",
                    )}
                  >
                    {option.label}
                    {active &&
                      (sortDir === "asc" ? (
                        <SFArrowUp size={9} />
                      ) : (
                        <SFArrowDown size={9} />
                      ))}
                  </button>
                );
              })}
              {sizing && (
                <span className="ml-auto flex items-center gap-1 text-[10px] text-mac-muted">
                  <Spinner size="sm" /> 统计占用中…
                </span>
              )}
            </div>

            <div className="max-h-[calc(100vh-365px)] min-h-[280px] overflow-y-auto p-1.5">
              {loading && apps.length === 0 ? (
                <div className="flex h-40 items-center justify-center gap-2 text-[12px] text-mac-muted">
                  <Spinner size="sm" /> 正在读取已安装程序…
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
                  <SFAppGrid size={20} className="text-mac-muted" />
                  <p className="text-[12px] text-mac-text">
                    {apps.length === 0 ? "没有读到已安装程序" : "没有匹配的程序"}
                  </p>
                  <p className="text-[10.5px] text-mac-muted">
                    {apps.length === 0 ? "卸载条目可能位于其他用户下" : "换个关键词试试"}
                  </p>
                </div>
              ) : (
                sorted.map((app) => {
                  const active = app.id === selectedId;
                  return (
                    <button
                      key={app.id}
                      type="button"
                      data-app-row={app.id}
                      onClick={() => {
                        setSelectedId(app.id);
                        setSelectedApp(app);
                      }}
                      title={`${app.name}${app.publisher ? ` · ${app.publisher}` : ""}`}
                      className={clsx(
                        "flex w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left transition-colors",
                        active
                          ? "bg-mac-blue/15 ring-1 ring-inset ring-mac-blue/45"
                          : "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]",
                      )}
                    >
                      <AppIcon app={app} icons={icons} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12.5px] font-medium text-mac-text">
                          {app.name}
                        </span>
                        <span className="block truncate text-[10.5px] text-mac-muted">
                          {app.publisher || "未知发布者"}
                          {app.version ? ` · ${app.version}` : ""}
                          {app.installDate ? ` · ${app.installDate}` : ""}
                        </span>
                      </span>
                      <span
                        className="flex shrink-0 flex-col items-end gap-0.5"
                        title={
                          app.sizeMeasured
                            ? app.sizePartial
                              ? "统计未完成，实际可能更大"
                              : "安装目录实测大小"
                            : "注册表登记的估计大小"
                        }
                      >
                        <span className="text-[11px] tabular-nums text-mac-text">
                          {sizeLabel(app)}
                        </span>
                        <span className="rounded-[3px] bg-black/[0.05] px-1 py-px text-[9px] text-mac-muted dark:bg-white/[0.08]">
                          {app.scope === "machine" ? "所有用户" : "当前用户"}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <aside className="min-w-0">
            {selected ? (
              <div className="flex flex-col gap-3 rounded-[10px] border border-mac-line bg-mac-chrome p-4">
                <div className="flex items-start gap-3">
                  <AppIcon app={selected} icons={icons} size={40} />
                  <div className="min-w-0">
                    <h2
                      className="truncate text-[14px] font-semibold text-mac-text"
                      title={selected.name}
                    >
                      {selected.name}
                    </h2>
                    <p className="truncate text-[11px] text-mac-muted">
                      {selected.publisher || "未知发布者"}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-mac-muted">
                      {selected.version && (
                        <span className="rounded-[4px] bg-black/[0.05] px-1.5 py-0.5 tabular-nums dark:bg-white/[0.08]">
                          v{selected.version}
                        </span>
                      )}
                      {selected.installDate && <span>安装于 {selected.installDate}</span>}
                    </div>
                  </div>
                </div>

                <dl className="grid gap-1.5">
                  <DetailRow
                    label="安装位置"
                    value={selected.installLocation || "未记录"}
                    mono={Boolean(selected.installLocation)}
                  />
                  <DetailRow
                    label="占用空间"
                    value={
                      sizeOf(selected) > 0
                        ? `${selected.sizeMeasured ? "" : "≈"}${formatBytes(sizeOf(selected))}${
                            selected.sizeMeasured
                              ? selected.sizePartial
                                ? "（统计未完成）"
                                : ""
                              : "（注册表估计）"
                          }`
                        : "未记录"
                    }
                  />
                </dl>

                <div className="flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => void uninstall(false)}
                    disabled={
                      busy !== null ||
                      waitingPid !== null ||
                      !inInventory ||
                      !selected.uninstallString
                    }
                    className={primaryButton}
                  >
                    {busy === "uninstall" ? "正在启动…" : "运行卸载程序"}
                  </button>
                  {selected.quietUninstallString && (
                    <button
                      type="button"
                      onClick={() => void uninstall(true)}
                      disabled={busy !== null || waitingPid !== null || !inInventory}
                      className={secondaryButton}
                    >
                      静默卸载
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void scan()}
                    disabled={busy !== null}
                    className={secondaryButton}
                  >
                    {busy === "scan" ? (
                      <>
                        <Spinner size="sm" /> 正在扫描…
                      </>
                    ) : (
                      "扫描卸载残留"
                    )}
                  </button>
                  {selected.installLocation && (
                    <button
                      type="button"
                      onClick={() => go(selected.installLocation)}
                      className="flex h-7 items-center justify-center gap-1.5 rounded-[6px] text-[11.5px] text-mac-blue transition-colors hover:bg-mac-blue/10"
                    >
                      <FolderOpen size={12} /> 在 Oriel 中打开安装位置
                    </button>
                  )}
                </div>

                {waitingPid !== null && (
                  <div className="flex items-center gap-2 rounded-[6px] bg-mac-blue/[0.08] px-2 py-1.5 text-[10.5px] leading-4 text-mac-blue">
                    <Spinner size="sm" />
                    <span className="min-w-0 flex-1">
                      等待卸载程序退出，完成后自动刷新并扫描残留…
                    </span>
                    <button
                      type="button"
                      onClick={skipWait}
                      className="shrink-0 font-medium hover:underline"
                    >
                      跳过
                    </button>
                  </div>
                )}

                {!inInventory && (
                  <p className="rounded-[6px] bg-black/[0.04] px-2 py-1.5 text-[10.5px] leading-4 text-mac-muted dark:bg-white/[0.05]">
                    这个条目已从已安装列表移除，可以继续扫描它留下的残留。
                  </p>
                )}

                {!selected.uninstallString && (
                  <p className="rounded-[6px] bg-[#ff9f0a]/[0.08] px-2 py-1.5 text-[10.5px] leading-4 text-[#a86a00] dark:text-[#ffb340]">
                    这个条目没有卸载命令，可能已经卸载了一半。直接点「扫描卸载残留」清理它。
                  </p>
                )}
                {notice && (
                  <p className="rounded-[6px] bg-mac-blue/[0.08] px-2 py-1.5 text-[10.5px] leading-4 text-mac-blue">
                    {notice}
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center rounded-[10px] border border-dashed border-mac-line bg-mac-chrome/60 px-4 py-10 text-center">
                <SFAppGrid size={22} className="text-mac-muted" />
                <p className="mt-2 text-[12px] font-medium text-mac-text">选择一个程序</p>
                <p className="mt-1 max-w-[220px] text-[10.5px] leading-4 text-mac-muted">
                  运行它自己的卸载程序，结束后会自动弹窗清理注册表和文件残留。
                </p>
              </div>
            )}
          </aside>
        </div>
      </div>

      <Modal.Backdrop isOpen={leftoverOpen} onOpenChange={(open) => !open && closeLeftovers()}>
        <Modal.Container placement="center" size="lg">
          <Modal.Dialog className="flex! max-h-[min(720px,calc(100vh-120px))] w-full max-w-[780px] flex-col overflow-hidden">
            <Modal.Header>
              <Modal.Heading className="flex items-center gap-2">
                <span className="grid size-7 place-items-center rounded-[7px] bg-[#ff453a]/10">
                  <SFXmarkBinFill size={15} className="text-[#ff453a]" />
                </span>
                卸载残留
              </Modal.Heading>
              <p className="text-[11px] text-mac-muted">
                {selected?.name}
                {leftovers
                  ? ` · ${leftovers.items.length} 项 · 共 ${formatBytes(leftovers.total)}`
                  : ""}
              </p>
            </Modal.Header>

            <Modal.Body className="min-h-0 flex-1 overflow-hidden px-0 py-0">
              {result ? (
                <div className="px-5 py-5">
                  <div className="flex items-start gap-2 rounded-[8px] border border-[#30d158]/30 bg-[#30d158]/[0.06] px-3 py-2.5">
                    <SFCheckmarkCircleFill
                      size={15}
                      className="mt-0.5 shrink-0 text-[#1f8a3b] dark:text-[#4ade80]"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[12.5px] font-medium text-[#1f8a3b] dark:text-[#4ade80]">
                        已删除 {result.deleted} 个文件，释放 {formatBytes(result.freed)}
                        {result.failed > 0 ? `，${result.failed} 项失败` : ""}
                      </p>
                      {failures.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-default text-[11px] text-mac-muted">
                            查看未能删除的项目（{failures.length}）
                          </summary>
                          <ul className="mt-1 max-h-[180px] space-y-0.5 overflow-y-auto font-mono text-[10.5px] leading-4 text-mac-muted">
                            {failures.slice(0, 20).map((failure, index) => (
                              <li key={`${failure}-${index}`} className="break-all">
                                {failure}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </div>
                </div>
              ) : scanError ? (
                <div className="px-5 py-6 text-[12px] leading-5 text-[#a86a00] dark:text-[#ffb340]">
                  {scanError}
                </div>
              ) : !leftovers ? (
                <div className="flex items-center justify-center gap-2 px-5 py-10 text-[12px] text-mac-muted">
                  <Spinner size="sm" /> 正在扫描…
                </div>
              ) : leftovers.items.length === 0 ? (
                <div className="flex items-center gap-2 px-5 py-10 text-[12px] text-[#1f8a3b] dark:text-[#4ade80]">
                  <SFCheckmarkSealFill size={16} className="shrink-0" />
                  没有扫描到残留，这个程序卸载得很干净。
                </div>
              ) : (
                <div className="flex min-h-0 flex-col">
                  <div className="flex items-center justify-between border-b border-mac-line px-5 py-2">
                    <span className="text-[11px] text-mac-muted">
                      勾选要永久删除的项目，灰色的「可能与其他程序共用」默认不选
                    </span>
                    <button
                      type="button"
                      onClick={toggleAll}
                      className="h-6 shrink-0 rounded-[5px] bg-mac-surface px-2 text-[11px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.08]"
                    >
                      {allChecked ? "全不选" : "全选"}
                    </button>
                  </div>
                  <div className="max-h-[380px] overflow-y-auto px-3 py-2">
                    {registryItems.length > 0 && (
                      <LeftoverGroup
                        title="注册表项"
                        items={registryItems}
                        checked={checked}
                        onToggle={toggle}
                      />
                    )}
                    {fileItems.length > 0 && (
                      <LeftoverGroup
                        title="文件与文件夹"
                        items={fileItems}
                        checked={checked}
                        onToggle={toggle}
                      />
                    )}
                  </div>
                </div>
              )}
            </Modal.Body>

            <Modal.Footer className="flex flex-wrap items-center justify-between gap-3">
              {result ? (
                <>
                  <span className="text-[11px] text-mac-muted">清理完成</span>
                  <button type="button" onClick={closeLeftovers} className={primaryButton}>
                    完成
                  </button>
                </>
              ) : (
                <>
                  <div className="text-[11px] text-mac-muted">
                    已选{" "}
                    <span className="font-medium text-mac-text">
                      {checkedItems.length}
                    </span>{" "}
                    项 · {formatBytes(checkedSize)}
                    {adminSelected > 0 && (
                      <span className="ml-2 text-[#a86a00] dark:text-[#ffb340]">
                        · {adminSelected} 项需要管理员权限
                      </span>
                    )}
                    {cautionSelected > 0 && (
                      <span className="ml-2 text-[#a86a00] dark:text-[#ffb340]">
                        · {cautionSelected} 项可能与其他程序共用
                      </span>
                    )}
                  </div>

                  {confirming ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-[#ff453a]">
                        确认永久删除？此操作不可撤销
                      </span>
                      <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        className={secondaryButton}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={() => void clean()}
                        disabled={busy !== null}
                        className={dangerButton}
                      >
                        {busy === "clean" ? "删除中…" : "确认删除"}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={closeLeftovers}
                        disabled={busy !== null}
                        className={secondaryButton}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirming(true)}
                        disabled={checkedItems.length === 0 || busy !== null}
                        className={dangerButton}
                      >
                        <Trash2 size={13} /> 永久删除所选
                      </button>
                    </div>
                  )}
                </>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}
