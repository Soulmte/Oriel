import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "@heroui/react";
import {
  SFArrowClockwise,
  SFCheckmarkCircleFill,
  SFChevronLeft,
  SFExclamationmarkTriangleFill,
  SFSparkles,
} from "sf-symbols-lib/dualtone";
import { ChevronRight, FolderOpen, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import type {
  CleanupCategoryDto,
  CleanupMetaDto,
  CleanupNodeDto,
  CleanupResultDto,
} from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { api, errorMessage } from "../lib/api";
import { formatBytes, parentPath } from "../lib/format";
import { isSameOrInside, pathCrumbs, squarify } from "../lib/treemap";
import { PopupMenu, type MenuItem } from "./PopupMenu";

function sizeLabel(value: number): string {
  return value > 0 ? formatBytes(value) : "—";
}

function looksLikeFile(path: string): boolean {
  return /\.[a-z0-9]{1,5}$/i.test(path);
}

const SYSTEM_FILES = [
  "pagefile.sys",
  "hiberfil.sys",
  "swapfile.sys",
  "dumpstack.log",
  "dumpstack.log.tmp",
];

function isSystemFile(name: string): boolean {
  return SYSTEM_FILES.includes(name.toLowerCase());
}

const PROTECTED_ROOTS = [
  "c:\\windows",
  "c:\\program files",
  "c:\\program files (x86)",
  "c:\\programdata",
  "c:\\$recycle.bin",
  "c:\\system volume information",
  "c:\\recovery",
];

/** Anything that must not be thrown in the recycle bin from the heatmap. */
function canTrash(node: CleanupNodeDto): boolean {
  if (node.kind === "file" && isSystemFile(node.name)) return false;
  if (/^[a-z]:\\?$/i.test(node.path)) return false;
  const lower = node.path.toLowerCase();
  return !PROTECTED_ROOTS.some(
    (root) => lower === root || lower.startsWith(`${root}\\`),
  );
}

interface CleanableInfo {
  color: "green" | "red" | "blue";
  inside: boolean;
  size: number;
  titles: string[];
}

/**
 * C: cleanup as a live treemap. The server streams each folder's size as it
 * walks it, so rectangles grow while the user is still waiting, and clicking a
 * rectangle descends into it instead of starting another blocking scan.
 */
export function DiskCleanupPage() {
  const notify = useExplorer((state) => state.notify);
  const drives = useExplorer((state) => state.drives);
  const currentFolder = useExplorer((state) => state.path);

  const [viewPath, setViewPath] = useState("C:\\");
  const [pathDraft, setPathDraft] = useState("C:\\");
  const [pathError, setPathError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [meta, setMeta] = useState<CleanupMetaDto | null>(null);
  const [nodes, setNodes] = useState<CleanupNodeDto[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [treeScanning, setTreeScanning] = useState(true);
  const [treePartial, setTreePartial] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const [categories, setCategories] = useState<CleanupCategoryDto[]>([]);
  const [categoriesDone, setCategoriesDone] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; node: CleanupNodeDto } | null>(
    null,
  );
  const [trash, setTrash] = useState<{ paths: string[]; size: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [result, setResult] = useState<CleanupResultDto | null>(null);

  const selectionTouched = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A new folder means a new picture; a manual rescan can keep the old one on
  // screen until fresh numbers replace it.
  useEffect(() => {
    setNodes([]);
    setMeta(null);
    setCurrent(null);
    setTreeScanning(true);
    setTreePartial(false);
    setStreamError(null);
    setConfirming(false);
    setResult(null);
    setSelectedNodes(new Set());
    setMenu(null);
    setTrash(null);
    setPathDraft(viewPath);
  }, [viewPath]);

  // A rescan keeps the previous result card, but the heatmap itself starts
  // fresh so deleted folders cannot linger as stale rectangles.
  useEffect(() => {
    setNodes([]);
    setCurrent(null);
    setTreeScanning(true);
    setTreePartial(false);
    setStreamError(null);
    setSelectedNodes(new Set());
  }, [nonce]);

  useEffect(() => {
    let finished = false;
    let source: EventSource | null = null;

    try {
      source = new EventSource(api.cleanupStreamUrl(viewPath));
    } catch {
      setTreeScanning(false);
      setStreamError("无法打开扫描连接");
      return;
    }

    source.addEventListener("meta", (event) => {
      if (!mounted.current) return;
      try {
        setMeta(JSON.parse((event as MessageEvent).data) as CleanupMetaDto);
      } catch {
        // Ignore malformed frames; the connection stays usable.
      }
    });

    source.addEventListener("scan", (event) => {
      if (!mounted.current) return;
      try {
        const data = JSON.parse((event as MessageEvent).data) as { name: string };
        setCurrent(data.name ?? null);
      } catch {
        // Ignore.
      }
    });

    source.addEventListener("node", (event) => {
      if (!mounted.current) return;
      let node: CleanupNodeDto;
      try {
        node = JSON.parse((event as MessageEvent).data) as CleanupNodeDto;
      } catch {
        return;
      }
      setNodes((previous) => {
        const index = previous.findIndex((item) => item.path === node.path);
        if (index === -1) return [...previous, node];
        const next = previous.slice();
        next[index] = node;
        return next;
      });
    });

    source.addEventListener("done", (event) => {
      finished = true;
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          partial: boolean;
        };
        if (mounted.current) setTreePartial(Boolean(data.partial));
      } catch {
        // Ignore.
      }
      if (mounted.current) {
        setTreeScanning(false);
        setCurrent(null);
      }
      source?.close();
    });

    source.onerror = (event) => {
      if (finished) return;
      const data = (event as MessageEvent).data;
      if (typeof data === "string" && data) {
        try {
          const parsed = JSON.parse(data) as { message?: string };
          if (mounted.current) setStreamError(parsed.message ?? "扫描失败");
        } catch {
          if (mounted.current) setStreamError("扫描失败");
        }
      } else if (mounted.current) {
        setStreamError((previous) => previous ?? "扫描连接中断");
      }
      if (mounted.current) {
        setTreeScanning(false);
        setCurrent(null);
      }
      source?.close();
    };

    return () => {
      source?.close();
    };
  }, [viewPath, nonce]);

  useEffect(() => {
    setCategoriesDone(false);
    let finished = false;
    let source: EventSource | null = null;

    try {
      source = new EventSource(api.cleanupCategoriesUrl());
    } catch {
      setCategoriesDone(true);
      return;
    }

    source.addEventListener("category", (event) => {
      if (!mounted.current) return;
      let category: CleanupCategoryDto;
      try {
        category = JSON.parse((event as MessageEvent).data) as CleanupCategoryDto;
      } catch {
        return;
      }
      setCategories((previous) => {
        const index = previous.findIndex((item) => item.id === category.id);
        if (index === -1) return [...previous, category];
        const next = previous.slice();
        next[index] = category;
        return next;
      });

      if (
        !selectionTouched.current &&
        category.risk === "safe" &&
        !category.needsAdmin &&
        category.size > 0
      ) {
        setSelected((previous) => {
          if (previous.has(category.id)) return previous;
          const next = new Set(previous);
          next.add(category.id);
          return next;
        });
      }
    });

    source.addEventListener("done", () => {
      finished = true;
      if (mounted.current) setCategoriesDone(true);
      source?.close();
    });

    source.onerror = () => {
      if (finished) return;
      if (mounted.current) setCategoriesDone(true);
      source?.close();
    };

    return () => {
      source?.close();
    };
  }, [nonce]);

  const totalSize = useMemo(
    () => nodes.reduce((sum, node) => sum + Math.max(0, node.size), 0),
    [nodes],
  );

  const layout = useMemo(() => {
    if (totalSize <= 0) return [];
    const rects = squarify(
      nodes.map((node) => ({ key: node.path, value: node.size })),
      100,
      100,
    );
    const byPath = new Map(nodes.map((node) => [node.path, node]));
    return rects
      .map((rect) => {
        const node = byPath.get(rect.key);
        return node ? { rect, node } : null;
      })
      .filter(
        (item): item is { rect: (typeof rects)[number]; node: CleanupNodeDto } =>
          item !== null,
      );
  }, [nodes, totalSize]);

  const cleanableFor = useCallback(
    (node: CleanupNodeDto): CleanableInfo | null => {
      const insideSafe = categories.filter(
        (category) =>
          category.risk === "safe" &&
          category.paths.some((path) => isSameOrInside(node.path, path)),
      );
      if (insideSafe.length > 0) {
        return {
          color: "green",
          inside: true,
          size: node.size,
          titles: insideSafe.map((category) => category.title),
        };
      }
      const insideCaution = categories.filter(
        (category) =>
          category.risk === "caution" &&
          category.paths.some((path) => isSameOrInside(node.path, path)),
      );
      if (insideCaution.length > 0) {
        return {
          color: "red",
          inside: true,
          size: node.size,
          titles: insideCaution.map((category) => category.title),
        };
      }
      if (node.kind === "file" && isSystemFile(node.name)) {
        return { color: "red", inside: true, size: node.size, titles: ["系统文件"] };
      }

      const containsGreen = categories.filter(
        (category) =>
          category.risk === "safe" &&
          category.paths.some((path) => isSameOrInside(path, node.path)),
      );
      const containsCaution = categories.filter(
        (category) =>
          category.risk === "caution" &&
          category.paths.some((path) => isSameOrInside(path, node.path)),
      );
      if (containsGreen.length > 0 || containsCaution.length > 0) {
        return {
          color: containsGreen.length > 0 ? "green" : "red",
          inside: false,
          size:
            containsGreen.reduce((sum, category) => sum + category.size, 0) +
            containsCaution.reduce((sum, category) => sum + category.size, 0),
          titles: [...containsGreen, ...containsCaution].map(
            (category) => category.title,
          ),
        };
      }
      return null;
    },
    [categories],
  );

  const selectedCategories = useMemo(
    () => categories.filter((category) => selected.has(category.id)),
    [categories, selected],
  );
  const selectedSize = useMemo(
    () => selectedCategories.reduce((sum, category) => sum + category.size, 0),
    [selectedCategories],
  );

  const drivePrefix = (meta?.drive ?? "C:\\").toLowerCase();
  const driveCategories = useMemo(
    () =>
      categories.filter((category) =>
        category.id === "recycle-bin"
          ? drivePrefix.startsWith("c:")
          : category.paths.some((path) =>
              path.toLowerCase().startsWith(drivePrefix),
            ),
      ),
    [categories, drivePrefix],
  );
  const barGreen = useMemo(
    () =>
      driveCategories
        .filter((category) => category.risk === "safe")
        .reduce((sum, category) => sum + category.size, 0),
    [driveCategories],
  );
  const barCaution = useMemo(
    () =>
      driveCategories
        .filter((category) => category.risk === "caution")
        .reduce((sum, category) => sum + category.size, 0),
    [driveCategories],
  );
  const systemTotal = useMemo(
    () =>
      nodes
        .filter((node) => node.kind === "file" && isSystemFile(node.name))
        .reduce((sum, node) => sum + node.size, 0),
    [nodes],
  );
  const barRed = barCaution + systemTotal;
  const barBlue = Math.max(0, (meta?.used ?? 0) - barGreen - barRed);

  const selectedNodeList = useMemo(
    () => nodes.filter((node) => selectedNodes.has(node.path)),
    [nodes, selectedNodes],
  );
  const selectedNodeSize = useMemo(
    () => selectedNodeList.reduce((sum, node) => sum + node.size, 0),
    [selectedNodeList],
  );
  const selectedBlocked = selectedNodeList.some((node) => !canTrash(node));

  const crumbs = useMemo(() => pathCrumbs(viewPath), [viewPath]);
  const usedPercent =
    meta && meta.total > 0
      ? Math.min(100, Math.max(0, (meta.used / meta.total) * 100))
      : 0;
  const greenPercent =
    meta && meta.total > 0
      ? Math.min(usedPercent, (barGreen / meta.total) * 100)
      : 0;
  const redPercent =
    meta && meta.total > 0
      ? Math.min(usedPercent - greenPercent, (barRed / meta.total) * 100)
      : 0;
  const bluePercent = Math.max(0, usedPercent - greenPercent - redPercent);
  const needsElevation =
    meta !== null &&
    !meta.elevated &&
    categories.some((category) => category.needsAdmin && category.size > 0);

  const navigateTo = (path: string) => {
    setPathError(null);
    if (path === viewPath) return;
    setViewPath(path);
  };

  // The path field accepts what users actually type: quotes, forward slashes,
  // `%VAR%` and `~`. Resolving first also means clicking 前往 on the current
  // path rescans it instead of doing nothing.
  const submitPath = async () => {
    const raw = pathDraft.trim().replace(/^"+|"+$/g, "").trim();
    if (!raw) {
      setPathError("请输入文件夹路径");
      return;
    }
    setPathError(null);
    try {
      const resolved = await api.resolvePath(raw);
      if (!resolved.exists) {
        setPathError(`找不到这个文件夹：${resolved.path || raw}`);
        return;
      }
      setPathDraft(resolved.path);
      if (resolved.path === viewPath) {
        setNonce((value) => value + 1);
      } else {
        setViewPath(resolved.path);
      }
    } catch (cause) {
      setPathError(errorMessage(cause));
    }
  };

  const toggle = (id: string) => {
    selectionTouched.current = true;
    setSelected((currentSelection) => {
      const next = new Set(currentSelection);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectSuggested = () => {
    selectionTouched.current = true;
    setSelected(
      new Set(
        categories
          .filter(
            (category) =>
              category.risk === "safe" &&
              !category.needsAdmin &&
              category.size > 0,
          )
          .map((category) => category.id),
      ),
    );
  };

  const locateCategory = (category: CleanupCategoryDto) => {
    const directory =
      category.paths.find((path) => !looksLikeFile(path)) ?? category.paths[0];
    if (directory) navigateTo(directory);
  };

  const toggleNode = (path: string) => {
    setSelectedNodes((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  /** "Locate" stays inside Oriel: the main file browser opens the folder. */
  const openInOriel = async (node: CleanupNodeDto) => {
    const store = useExplorer.getState();
    if (node.kind === "directory") {
      await store.navigate(node.path);
      return;
    }
    const parent = parentPath(node.path, "win32");
    if (parent) {
      await store.navigate(parent);
      store.selectPaths([node.path]);
    }
  };

  const askTrash = (targets: CleanupNodeDto[]) => {
    const allowed = targets.filter(canTrash);
    if (allowed.length === 0) {
      notify("系统文件或系统目录不能移到废纸篓");
      return;
    }
    setTrash({
      paths: allowed.map((node) => node.path),
      size: allowed.reduce((sum, node) => sum + node.size, 0),
    });
  };

  const confirmTrash = async () => {
    if (!trash) return;
    try {
      const data = await api.remove(trash.paths, false);
      notify(`已移到废纸篓：${data.deleted} 项`);
      setTrash(null);
      setMenu(null);
      setSelectedNodes(new Set());
      setNonce((value) => value + 1);
    } catch (cause) {
      notify(errorMessage(cause));
    }
  };

  const clean = async () => {
    const ids = selectedCategories
      .filter((category) => category.size > 0)
      .map((category) => category.id);
    if (ids.length === 0) return;
    setCleaning(true);
    try {
      const data = await api.cleanupRun(ids);
      if (!mounted.current) return;
      setResult(data);
      setConfirming(false);
      selectionTouched.current = false;
      setSelected(new Set());
      notify(
        data.freed > 0
          ? `已释放 ${formatBytes(data.freed)}`
          : data.failed > 0
            ? "部分文件未能删除"
            : "这些项目已经是空的",
      );
      setNonce((value) => value + 1);
    } catch (cause) {
      notify(errorMessage(cause));
    } finally {
      if (mounted.current) setCleaning(false);
    }
  };

  const failures = useMemo(
    () =>
      (result?.items ?? []).flatMap((item) =>
        item.errors.map((error) => `${item.title}：${error}`),
      ),
    [result],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-mac-surface">
      <div className="mx-auto w-full max-w-[1180px] px-5 pb-14 pt-7">
        <header className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-mac-text">
              磁盘清理
            </h1>
            <p className="mt-1 text-[12px] leading-5 text-mac-muted">
              热力图会一边扫描一边出现：方块越大占得越多。绿色表示可以清理，红色表示不建议删除，蓝色是普通内容。
              点击方块下钻，右键更多操作，Ctrl/⌘ 点击可多选。
            </p>
          </div>
          <button
            type="button"
            disabled={treeScanning}
            onClick={() => setNonce((value) => value + 1)}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] bg-mac-surface px-2.5 text-[12px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] disabled:opacity-45 dark:hover:bg-white/[0.08]"
          >
            <SFArrowClockwise
              size={13}
              className={treeScanning ? "animate-spin" : undefined}
            />
            {treeScanning ? "扫描中…" : "重新扫描"}
          </button>
        </header>

        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-[8px] bg-black/[0.025] px-2.5 py-2 dark:bg-white/[0.03]">
          <span className="shrink-0 text-[11px] text-mac-muted">检索范围</span>
          <div className="flex flex-wrap gap-1">
            {drives.map((drive) => {
              const active = viewPath
                .toLowerCase()
                .startsWith(drive.path.toLowerCase());
              return (
                <button
                  key={drive.path}
                  type="button"
                  onClick={() => navigateTo(drive.path)}
                  title={`${drive.label || drive.name} · ${drive.path}`}
                  className={clsx(
                    "h-6 rounded-[5px] px-2 text-[11.5px] tabular-nums transition-colors",
                    active
                      ? "bg-mac-blue font-medium text-white"
                      : "bg-mac-surface text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] hover:bg-black/[0.04] dark:hover:bg-white/[0.08]",
                  )}
                >
                  {drive.name}
                </button>
              );
            })}
            {currentFolder && (
              <button
                type="button"
                onClick={() => navigateTo(currentFolder)}
                title={`扫描 ${currentFolder}`}
                className="h-6 rounded-[5px] bg-mac-surface px-2 text-[11px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.08]"
              >
                当前文件夹
              </button>
            )}
          </div>
          <form
            className="ml-auto flex min-w-[190px] flex-1 items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void submitPath();
            }}
          >
            <input
              value={pathDraft}
              onChange={(event) => {
                setPathDraft(event.target.value);
                if (pathError) setPathError(null);
              }}
              placeholder="输入任意文件夹路径后回车"
              aria-label="扫描路径"
              spellCheck={false}
              className="h-6 min-w-0 flex-1 rounded-[5px] bg-mac-surface px-2 font-mono text-[10.5px] text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] outline-none placeholder:font-sans placeholder:text-mac-muted focus:ring-2 focus:ring-mac-blue/35"
            />
            <button
              type="submit"
              className="h-6 shrink-0 rounded-[5px] px-2 text-[11px] text-mac-blue transition-colors hover:bg-mac-blue/10"
            >
              前往
            </button>
          </form>
        </div>

        {pathError && (
          <div className="-mt-2 mb-3 text-[10.5px] leading-4 text-[#c77700] dark:text-[#ffb340]">
            {pathError}
          </div>
        )}

        <section className="rounded-[10px] border border-mac-line bg-mac-chrome px-3.5 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex min-w-0 shrink items-center gap-2">
              <span className="grid size-7 shrink-0 place-items-center rounded-[7px] bg-mac-blue/10">
                <SFSparkles size={15} className="text-mac-blue" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium text-mac-text">
                  {meta
                    ? `${meta.drive.replace(/\\/g, "")} 盘`
                    : "正在读取磁盘信息…"}
                </div>
                <div className="truncate text-[10.5px] tabular-nums text-mac-muted">
                  {meta
                    ? `已用 ${formatBytes(meta.used)} / 共 ${formatBytes(meta.total)} · 可用 ${formatBytes(meta.free)}`
                    : "…"}
                </div>
              </div>
            </div>

            <div
              className="flex h-2 min-w-[90px] flex-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.12]"
              role="img"
              aria-label="磁盘占用构成"
            >
              <div
                className="h-full bg-[#0a84ff]"
                style={{ width: `${bluePercent}%` }}
                title={`普通内容 ${formatBytes(barBlue)}`}
              />
              <div
                className="h-full bg-[#30d158]"
                style={{ width: `${greenPercent}%` }}
                title={`可清理 ${formatBytes(barGreen)}`}
              />
              <div
                className="h-full bg-[#ff453a]"
                style={{ width: `${redPercent}%` }}
                title={`不建议删除 ${formatBytes(barRed)}`}
              />
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] tabular-nums">
              <span className="flex items-center gap-1 text-mac-muted">
                <span className="size-2 rounded-[2px] bg-[#30d158]" />
                可清理 <span className="text-mac-text">{sizeLabel(barGreen)}</span>
              </span>
              <span className="flex items-center gap-1 text-mac-muted">
                <span className="size-2 rounded-[2px] bg-[#0a84ff]" />
                正常 <span className="text-mac-text">{sizeLabel(barBlue)}</span>
              </span>
              <span className="flex items-center gap-1 text-mac-muted">
                <span className="size-2 rounded-[2px] bg-[#ff453a]" />
                不建议删 <span className="text-mac-text">{sizeLabel(barRed)}</span>
              </span>
            </div>
          </div>
        </section>

        {result && (
          <section className="mt-3 rounded-[10px] border border-[#30d158]/30 bg-[#30d158]/[0.06] px-4 py-3">
            <div className="flex items-start gap-2">
              <SFCheckmarkCircleFill
                size={15}
                className="mt-0.5 shrink-0 text-[#1f8a3b] dark:text-[#4ade80]"
              />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-medium text-[#1f8a3b] dark:text-[#4ade80]">
                  已释放 {formatBytes(result.freed)}，删除 {result.deleted} 个文件
                  {result.failed > 0 ? `，${result.failed} 个失败` : ""}
                </p>
                {failures.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-default text-[11px] text-mac-muted">
                      查看未能删除的项目（{failures.length}）
                    </summary>
                    <ul className="mt-1 max-h-[120px] space-y-0.5 overflow-y-auto font-mono text-[10.5px] leading-4 text-mac-muted">
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
          </section>
        )}

        {streamError && (
          <div className="mt-3 rounded-[10px] border border-[#ff9f0a]/35 bg-[#ff9f0a]/[0.07] px-4 py-2.5 text-[12px] leading-5 text-[#c77700] dark:text-[#ffb340]">
            {streamError}
          </div>
        )}

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="flex min-w-0 flex-col rounded-[10px] border border-mac-line bg-mac-chrome p-3">
            <div className="mb-2.5 flex items-center gap-1.5 overflow-x-auto">
              {meta?.parent && (
                <button
                  type="button"
                  onClick={() => navigateTo(meta.parent as string)}
                  title="上一级"
                  aria-label="上一级"
                  className="grid size-6 shrink-0 place-items-center rounded-[5px] text-mac-muted transition-colors hover:bg-black/[0.06] hover:text-mac-text dark:hover:bg-white/[0.09]"
                >
                  <SFChevronLeft size={11} />
                </button>
              )}
              {crumbs.map((crumb, index) => (
                <span key={crumb.path} className="flex shrink-0 items-center gap-1.5">
                  {index > 0 && (
                    <span className="text-[10px] text-mac-muted/60">›</span>
                  )}
                  <button
                    type="button"
                    onClick={() => navigateTo(crumb.path)}
                    className={clsx(
                      "max-w-[180px] truncate rounded-[4px] px-1 text-[11.5px] transition-colors",
                      index === crumbs.length - 1
                        ? "font-medium text-mac-text"
                        : "text-mac-muted hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/[0.08]",
                    )}
                  >
                    {crumb.label}
                  </button>
                </span>
              ))}

              <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3 text-[10.5px] text-mac-muted">
                {treeScanning ? (
                  <>
                    <span className="size-1.5 animate-pulse rounded-full bg-[#30d158]" />
                    {current ? `正在统计 ${current}…` : "正在读取…"}
                  </>
                ) : (
                  <>
                    扫描完成 · {nodes.length} 项
                    {treePartial ? " · 部分未统计完" : ""}
                  </>
                )}
              </span>
            </div>

            {(selectedNodeList.length > 0 || trash) && (
              <div className="mb-2 flex flex-wrap items-center gap-2 rounded-[6px] bg-mac-blue/[0.08] px-2 py-1.5 text-[11px]">
                {trash ? (
                  <>
                    <span className="text-mac-text">
                      将 {trash.paths.length} 项（{formatBytes(trash.size)}）移到废纸篓？
                    </span>
                    <button
                      type="button"
                      onClick={() => void confirmTrash()}
                      className="h-6 rounded-[5px] bg-[#ff453a] px-2 font-medium text-white hover:opacity-90"
                    >
                      确认
                    </button>
                    <button
                      type="button"
                      onClick={() => setTrash(null)}
                      className="h-6 rounded-[5px] px-2 text-mac-muted hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <span className="text-mac-text">
                      已选 {selectedNodeList.length} 项 · {formatBytes(selectedNodeSize)}
                    </span>
                    {selectedBlocked && (
                      <span className="text-[#c77700] dark:text-[#ffb340]">
                        含系统文件或系统目录
                      </span>
                    )}
                    {selectedNodeList.length === 1 && (
                      <button
                        type="button"
                        onClick={() => void openInOriel(selectedNodeList[0] as CleanupNodeDto)}
                        className="h-6 rounded-[5px] px-2 text-mac-blue hover:bg-mac-blue/10"
                      >
                        在 Oriel 中打开
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={selectedBlocked}
                      onClick={() => askTrash(selectedNodeList)}
                      className="h-6 rounded-[5px] px-2 text-[#ff453a] hover:bg-[#ff453a]/10 disabled:opacity-35"
                    >
                      移到废纸篓
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedNodes(new Set())}
                      className="h-6 rounded-[5px] px-2 text-mac-muted hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                    >
                      取消选择
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="relative h-[480px] overflow-hidden rounded-[7px] bg-black/[0.03] dark:bg-white/[0.035]">
              {layout.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-mac-muted">
                  <Spinner size="sm" />
                  <span className="text-[11.5px]">
                    {treeScanning ? "正在统计目录大小…" : "这个文件夹里没有内容"}
                  </span>
                </div>
              ) : (
                layout.map(({ rect, node }) => {
                  const share = totalSize > 0 ? node.size / totalSize : 0;
                  const info = cleanableFor(node);
                  const isSelected = selectedNodes.has(node.path);
                  const inside = info?.inside === true;
                  const base = inside
                    ? info?.color === "green"
                      ? "48, 209, 88"
                      : "255, 69, 58"
                    : "10, 132, 255";
                  const borderBase =
                    info?.color === "green" ? "48, 209, 88" : "255, 69, 58";
                  const alpha = inside
                    ? 0.52 + Math.min(0.26, share * 0.5)
                    : 0.16 + Math.min(0.42, share * 0.6);
                  const background = `rgba(${base}, ${alpha})`;
                  const borderColor = info
                    ? `rgba(${borderBase}, ${inside ? 0.85 : 0.55})`
                    : "var(--color-mac-line)";
                  const showLabel = rect.width * rect.height >= 48;
                  const showMeta = rect.width >= 13 && rect.height >= 8;
                  const badge = info
                    ? info.inside
                      ? info.color === "green"
                        ? "可清理"
                        : "不建议删"
                      : info.color === "green"
                        ? `含可清理 ${formatBytes(info.size)}`
                        : "含谨慎项"
                    : null;
                  const showBadge =
                    badge !== null && rect.width >= 15 && rect.height >= 10;

                  return (
                    <button
                      key={rect.key}
                      type="button"
                      onClick={(event) => {
                        if (event.ctrlKey || event.metaKey) {
                          toggleNode(node.path);
                          return;
                        }
                        if (node.kind === "directory") navigateTo(node.path);
                        else toggleNode(node.path);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setMenu({ x: event.clientX, y: event.clientY, node });
                      }}
                      title={`${node.path}\n${formatBytes(node.size)}${
                        info ? `\n${info.titles.join("、")}` : ""
                      }`}
                      aria-label={`${node.name}，${formatBytes(node.size)}${
                        info ? `，${info.color === "green" ? "可清理" : "不建议删除"}` : ""
                      }`}
                      className={clsx(
                        "absolute cursor-pointer overflow-hidden border text-left outline-none",
                        "transition-[background-color] duration-150 ease-out",
                        "hover:z-10 hover:brightness-110 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-mac-blue",
                        isSelected && "z-10 ring-2 ring-mac-blue ring-inset",
                        info?.inside &&
                          (info.color === "green"
                            ? "text-[#06240f] dark:text-[#f4fff7]"
                            : "text-[#3a0603] dark:text-[#fff2f1]"),
                      )}
                      style={{
                        left: `${rect.x}%`,
                        top: `${rect.y}%`,
                        width: `${rect.width}%`,
                        height: `${rect.height}%`,
                        background,
                        borderColor,
                        borderStyle: info && !info.inside ? "dashed" : "solid",
                      }}
                    >
                      {showLabel && (
                        <span className="pointer-events-none absolute inset-0 flex flex-col gap-0.5 p-1.5">
                          <span className="truncate text-[10.5px] font-medium leading-3.5">
                            {node.name}
                          </span>
                          {showMeta && (
                            <span className="truncate text-[9.5px] tabular-nums opacity-75">
                              {formatBytes(node.size)}
                              {!node.complete ? " …" : ""}
                              {node.partial ? " · 未统计完" : ""}
                            </span>
                          )}
                          {showBadge && badge && (
                            <span
                              className={clsx(
                                "mt-auto self-start rounded-[3px] px-1 py-px text-[9px] font-medium",
                                info?.color === "green"
                                  ? "bg-[#30d158]/90 text-[#06301a]"
                                  : "bg-[#ff453a]/90 text-white",
                              )}
                            >
                              {badge}
                            </span>
                          )}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-mac-muted">
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-[2px] bg-[#0a84ff]/45" />
                普通内容（越深占比越大）
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-[2px] bg-[#30d158]/60" />
                可清理
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-[2px] bg-[#ff453a]/55" />
                不建议删除
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-[2px] border border-dashed border-[#30d158]" />
                含可清理内容
              </span>
              <span className="ml-auto hidden sm:inline">
                左键下钻 · Ctrl/⌘ 点击多选 · 右键更多
              </span>
            </div>
          </section>

          <aside className="flex h-[560px] min-h-0 flex-col rounded-[10px] border border-mac-line bg-mac-chrome">
            <div className="flex items-center justify-between gap-3 border-b border-mac-line px-3 py-2.5">
              <span className="text-[11px] font-medium text-mac-muted">清理建议</span>
              <span className="text-[10.5px] tabular-nums text-mac-muted">
                {categoriesDone
                  ? `${categories.filter((c) => c.size > 0).length} 项可清理`
                  : "加载中…"}
              </span>
            </div>
            {meta && !meta.drive.toLowerCase().startsWith("c:") && (
              <div className="border-b border-mac-line px-3 py-1.5 text-[10px] leading-4 text-mac-muted">
                系统清理项位于 C: 盘；当前磁盘可在热力图中多选后移到废纸篓。
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
              {categories.length === 0 && !categoriesDone ? (
                <div className="flex flex-col gap-2 px-1 py-2">
                  {[0, 1, 2].map((index) => (
                    <div
                      key={index}
                      className="h-[54px] animate-pulse rounded-[7px] bg-black/[0.04] dark:bg-white/[0.05]"
                    />
                  ))}
                </div>
              ) : categories.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11.5px] text-mac-muted">
                  没有找到可清理的项目
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {categories.map((category) => {
                    const disabled = category.size === 0;
                    const isSelected = selected.has(category.id);
                    return (
                      <div
                        key={category.id}
                        className={clsx(
                          "rounded-[7px] px-2 py-1.5 transition-colors",
                          isSelected
                            ? "bg-mac-blue/[0.08]"
                            : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]",
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            disabled={disabled || cleaning}
                            onChange={() => toggle(category.id)}
                            aria-label={`选择 ${category.title}`}
                            className="mt-[3px] size-[13px] shrink-0 accent-[var(--color-mac-blue)] disabled:opacity-35"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={clsx(
                                  "size-1.5 shrink-0 rounded-full",
                                  category.risk === "caution"
                                    ? "bg-[#ff453a]"
                                    : "bg-[#30d158]",
                                )}
                              />
                              <span
                                className={clsx(
                                  "truncate text-[11.5px] font-medium",
                                  disabled ? "text-mac-muted" : "text-mac-text",
                                )}
                              >
                                {category.title}
                              </span>
                              {category.risk === "caution" ? (
                                <span className="shrink-0 rounded-[3px] bg-[#ff453a]/12 px-1 py-px text-[9px] text-[#d70015] dark:text-[#ff8a80]">
                                  谨慎
                                </span>
                              ) : (
                                <span className="shrink-0 rounded-[3px] bg-[#30d158]/12 px-1 py-px text-[9px] text-[#1f8a3b] dark:text-[#4ade80]">
                                  安全
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[9.5px] text-mac-muted">
                              {category.size > 0 ? (
                                <span className="tabular-nums">
                                  {formatBytes(category.size)}
                                </span>
                              ) : category.needsAdmin ? (
                                <span>需管理员</span>
                              ) : (
                                <span>空</span>
                              )}
                              {category.files > 0 && (
                                <span className="tabular-nums">
                                  · {category.files} 项
                                </span>
                              )}
                              {category.partial && <span>· 未统计完</span>}
                              {category.needsAdmin && category.size > 0 && (
                                <span>· 需管理员</span>
                              )}
                              {category.paths.length > 0 && (
                                <button
                                  type="button"
                                  onClick={() => locateCategory(category)}
                                  className="text-mac-blue transition-colors hover:underline"
                                >
                                  定位
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {needsElevation && (
              <div className="mx-2 mb-1 flex items-start gap-1.5 rounded-[6px] bg-[#ff9f0a]/[0.08] px-2 py-1.5 text-[10px] leading-4 text-[#c77700] dark:text-[#ffb340]">
                <SFExclamationmarkTriangleFill size={11} className="mt-0.5 shrink-0" />
                系统级项目需要以管理员身份运行 Oriel 才能删除
              </div>
            )}

            <div className="border-t border-mac-line px-3 py-2.5">
              <div className="mb-2 flex items-center justify-between text-[11px]">
                <span className="text-mac-muted">
                  已选 {selectedCategories.length} 项 · {sizeLabel(selectedSize)}
                </span>
                <button
                  type="button"
                  onClick={selectSuggested}
                  disabled={cleaning}
                  className="text-[11px] text-mac-blue transition-colors hover:underline disabled:opacity-40"
                >
                  选中建议项
                </button>
              </div>

              {confirming ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-[10.5px] leading-4 text-[#c77700] dark:text-[#ffb340]">
                    将永久删除所选内容，未保存的文件请先保存。
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void clean()}
                      disabled={cleaning}
                      className="h-7 flex-1 rounded-[6px] bg-[#ff453a] px-2 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {cleaning ? "正在清理…" : `确认清理 ${sizeLabel(selectedSize)}`}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(false)}
                      disabled={cleaning}
                      className="h-7 rounded-[6px] px-2.5 text-[11.5px] text-mac-muted hover:bg-black/[0.05] disabled:opacity-40 dark:hover:bg-white/[0.08]"
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={selectedSize === 0 || cleaning}
                  className="h-7 w-full rounded-[6px] bg-mac-blue px-2 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  清理所选
                </button>
              )}
            </div>
          </aside>
        </div>

        <p className="mt-4 px-1 text-[11px] leading-4 text-mac-muted">
          清理只会删除固定位置（临时文件、更新缓存、日志、回收站等）；被占用或权限不足的文件会跳过。
          热力图中的大小会随着扫描实时增长，可以先点开感兴趣的目录，不必等整盘扫完。
          热力图里的「移到废纸篓」会进入回收站，可随时恢复；系统文件与系统目录不允许从热力图直接删除。
        </p>
      </div>

      {menu && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          minWidth={224}
          onClose={() => setMenu(null)}
          items={[
            {
              id: "open-in-oriel",
              label: menu.node.kind === "directory" ? "在 Oriel 中打开" : "在 Oriel 中定位",
              icon: <FolderOpen className="size-3.5" />,
              onSelect: () => {
                const node = menu.node;
                setMenu(null);
                void openInOriel(node);
              },
            },
            ...(menu.node.kind === "directory"
              ? [
                  {
                    id: "expand-here",
                    label: "在此处展开热力图",
                    icon: <ChevronRight className="size-3.5" />,
                    onSelect: () => {
                      const node = menu.node;
                      setMenu(null);
                      navigateTo(node.path);
                    },
                  } as MenuItem,
                ]
              : []),
            { id: "sep", separator: true } as MenuItem,
            {
              id: "trash",
              label: "移到废纸篓",
              icon: <Trash2 className="size-3.5" />,
              danger: true,
              disabled: !canTrash(menu.node),
              onSelect: () => {
                const node = menu.node;
                setMenu(null);
                askTrash([node]);
              },
            } as MenuItem,
          ]}
        />
      )}
    </div>
  );
}
