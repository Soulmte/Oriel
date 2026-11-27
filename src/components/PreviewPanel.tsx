import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EntryDto,
  FileInfoDto,
  PreviewResponse,
} from "@oriel/shared";
import { clsx } from "clsx";
import {
  SFChevronRight,
  SFEye,
  SFFolderFill,
  SFXmark,
} from "sf-symbols-lib/dualtone";
import { useExplorer } from "../store/explorer";
import { FileIcon, thumbnailFor } from "../lib/fileIcons";
import { api } from "../lib/api";
import { buildArchivePath, isArchivePath, isBrowsableArchive } from "../lib/archivePath";
import {
  fileKindLabel,
  formatAgo,
  formatBytes,
  formatDate,
  parentPath,
} from "../lib/format";
import { Markdown } from "../lib/markdown";

/** Types that never carry readable text, so we skip the preview request. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "jfif", "gif", "webp", "avif", "bmp", "ico", "heic",
  "tif", "tiff", "psd", "ai", "eps", "fig", "sketch", "xd",
  "mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v", "mpg", "mpeg",
  "mp3", "wav", "flac", "m4a", "ogg", "opus", "aac", "wma", "aiff",
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "cab", "deb", "rpm",
  "exe", "msi", "msix", "msixbundle", "appx", "apk", "ipa", "dll", "sys",
  "iso", "img", "vhd", "vhdx", "dmg",
  "pdf", "doc", "dot", "rtf", "odt", "pages",
  "xls", "xlsx", "xlsm", "xlsb", "ods", "numbers",
  "ppt", "pps", "odp", "key",
  "epub", "mobi", "azw", "azw3", "fb2", "djvu", "chm",
  "ttf", "otf", "woff", "woff2", "eot",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mov", "mkv", "avi", "wmv", "flv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "m4a", "ogg", "opus", "aac", "wma", "aiff"]);
/** Formats whose transparency reads better on a checkerboard. */
const ALPHA_IMAGE_EXTENSIONS = new Set(["png", "webp", "gif", "avif", "svg", "ico", "tif", "tiff"]);

const MAX_PREVIEW_CHARS = 20000;
/** Rendered as formatted text instead of a raw code block. */
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);
/** Office packages whose text the service extracts with 7-Zip. */
const OFFICE_TEXT_EXTS = new Set([
  "docx", "docm", "dotx", "dotm", "pptx", "pptm", "ppsx", "potx",
]);
/** Prose wraps by default; code keeps its own line breaks and a line gutter. */
const WRAP_BY_DEFAULT = new Set([
  "txt", "log", "csv", "srt", "vtt", "rtf",
  "docx", "docm", "dotx", "dotm", "pptx", "pptm", "ppsx", "potx",
]);
/** Entries listed under 内容 / 归档内容. */
const CHILD_LIMIT = 10;
/** Icons shown in the multi-selection collage. */
const MULTI_ICON_LIMIT = 6;
/** Rows listed under 选中的项目. */
const MULTI_ROW_LIMIT = 12;
/** Refuse to launch an unreasonable number of apps from one click. */
const OPEN_ALL_LIMIT = 15;
/** Quiet footer button: text only, surface on hover, like a macOS pane. */
const PANEL_BUTTON =
  "flex h-7 min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-[6px] px-2 text-[11.5px] " +
  "transition-colors duration-100 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] " +
  "outline-none focus-visible:ring-2 focus-visible:ring-mac-blue/50";
const TAB_BUTTON =
  "whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10.5px] transition-colors duration-100";
const TAB_ON = `${TAB_BUTTON} bg-mac-surface text-mac-text shadow-[0_1px_2px_rgba(0,0,0,0.14)]`;
const TAB_OFF = `${TAB_BUTTON} text-mac-muted hover:text-mac-text`;
const ROW_BUTTON =
  "flex w-full items-center gap-1.5 rounded-[4px] px-1 py-0.5 text-left text-[11.5px] text-mac-text " +
  "transition-colors hover:bg-black/[0.05] dark:hover:bg-white/[0.08]";
const MIN_WIDTH = 220;
const MAX_WIDTH = 560;
const WIDTH_KEY = "oriel:pref-preview-width";

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

function readWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampWidth(raw) : 300;
  } catch {
    return 300;
  }
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function InfoRow({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-start gap-2 py-[3px]">
      <span className="w-[48px] shrink-0 text-[11px] text-mac-muted">{label}</span>
      <span
        className={clsx(
          "min-w-0 flex-1 select-text break-words text-[12px] text-mac-text",
          mono && "font-mono text-[11px]",
        )}
        title={title ?? value}
      >
        {value}
      </span>
    </div>
  );
}

/** Section heading shared by 内容, 归档内容 and 选中的项目. */
function SectionTitle({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-baseline gap-1">
      <span className="text-[11px] font-medium text-mac-muted">{label}</span>
      {hint && (
        <span className="text-[10.5px] text-mac-muted/70">{hint}</span>
      )}
    </div>
  );
}

export function PreviewPanel() {
  const open = useExplorer((state) => state.previewOpen);
  const selected = useExplorer((state) => state.selected);
  const entries = useExplorer((state) => state.entries);
  const results = useExplorer((state) => state.results);
  const query = useExplorer((state) => state.query);
  const platform = useExplorer((state) => state.system?.platform ?? "win32");
  const openEntry = useExplorer((state) => state.openEntry);
  const reveal = useExplorer((state) => state.reveal);
  const notify = useExplorer((state) => state.notify);
  const setPreviewOpen = useExplorer((state) => state.setPreviewOpen);
  const navigate = useExplorer((state) => state.navigate);
  const selectOnly = useExplorer((state) => state.selectOnly);
  const openDialog = useExplorer((state) => state.openDialog);
  const shellIcons = useExplorer((state) => state.shellIcons);

  const [width, setWidth] = useState(readWidth);
  const layoutEpoch = useExplorer((state) => state.layoutEpoch);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const [info, setInfo] = useState<FileInfoDto | null>(null);
  const [text, setText] = useState<PreviewResponse | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [textMode, setTextMode] = useState<"render" | "source">("render");
  const [wrap, setWrap] = useState(true);
  const [children, setChildren] = useState<EntryDto[] | null>(null);
  const [childCount, setChildCount] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const sourceEntries = useMemo(
    () => (query.trim() && results ? results : entries),
    [entries, results, query],
  );

  const selectedEntries = useMemo(() => {
    if (selected.length <= 1) return [];
    const byPath = new Map<string, EntryDto>();
    for (const item of sourceEntries) byPath.set(item.path, item);
    return selected
      .map((path) => byPath.get(path))
      .filter((item): item is EntryDto => Boolean(item));
  }, [selected, sourceEntries]);

  const entry = useMemo<EntryDto | null>(() => {
    if (selected.length === 0) return null;
    const last = selected[selected.length - 1];
    return sourceEntries.find((item) => item.path === last) ?? null;
  }, [selected, sourceEntries]);

  const isMulti = selected.length > 1;

  const entryPath = entry?.path ?? "";
  const shellIcon = entry ? shellIcons[entry.path] : undefined;
  const entryExt = entry?.ext ?? "";
  const isDirectory = entry?.kind === "directory";
  const isVideo = VIDEO_EXTENSIONS.has(entryExt);
  const isAudio = AUDIO_EXTENSIONS.has(entryExt);
  // WebView2 ships the Chromium PDF viewer, so a PDF only needs a URL.
  const isPdf = entryExt === "pdf";
  // SVG is rendered by the browser itself, no rasterising needed.
  const isSvg = entryExt === "svg";
  const skipText = !entry || isDirectory || BINARY_EXTENSIONS.has(entryExt);

  const requestFolderSizes = useExplorer((state) => state.requestFolderSizes);
  const dirSize = useExplorer((state) =>
    entryPath ? state.folderSizes[entryPath] : undefined,
  );

  /** Viewing an entry that lives inside an archive virtual path. */
  const archiveNode = isArchivePath(entryPath);
  /** A real archive file selected in the listing. */
  const archiveFile =
    Boolean(entry) && !isDirectory && !archiveNode && isBrowsableArchive(entryExt);
  /** Both of these can be listed, but their children may not open like real files. */
  const virtualTree = archiveNode || archiveFile;
  const listable = isDirectory || archiveFile;

  // Reset per-selection view state.
  useEffect(() => {
    setMediaFailed(false);
    setImageFailed(false);
    setDuration(null);
    setTextMode("render");
    setWrap(!entryExt || WRAP_BY_DEFAULT.has(entryExt));
  }, [entryPath, entryExt]);

  // "重置布局" in the settings bumps this counter.
  useEffect(() => {
    if (layoutEpoch === 0) return;
    setWidth(clampWidth(300));
    try {
      localStorage.setItem(WIDTH_KEY, "300");
    } catch {
      // Ignore.
    }
  }, [layoutEpoch]);

  // Extended metadata.
  useEffect(() => {
    setInfo(null);
    if (!entryPath) return;
    let cancelled = false;
    api
      .info(entryPath)
      .then((response) => {
        if (!cancelled) setInfo(response);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [entryPath]);

  // Recursive folder size comes from the shared cache so the list view and the
  // panel never walk the same folder twice.
  useEffect(() => {
    if (entryPath && isDirectory) requestFolderSizes([entryPath]);
  }, [entryPath, isDirectory, requestFolderSizes]);

  // A folder's first few entries (or an archive's), so the panel shows what is
  // inside instead of just an icon. A real .zip has to be addressed through its
  // archive:// virtual root; the raw file path lists the file itself.
  useEffect(() => {
    setChildren(null);
    setChildCount(0);
    if (!entryPath || !listable) return;
    let cancelled = false;
    api
      .list(archiveFile ? buildArchivePath(entryPath, "") : entryPath, false)
      .then((response) => {
        if (cancelled) return;
        setChildCount(response.entries.length);
        setChildren(response.entries.slice(0, CHILD_LIMIT));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [entryPath, listable, archiveFile]);

  // Text preview.
  useEffect(() => {
    setText(null);
    if (!entryPath || skipText) {
      setTextLoading(false);
      return;
    }
    let cancelled = false;
    setTextLoading(true);
    api
      .preview(entryPath)
      .then((response) => {
        if (!cancelled) setText(response);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setTextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryPath, skipText]);

  const startDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [width]);

  const moveDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setWidth(clampWidth(drag.startWidth - (event.clientX - drag.startX)));
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    try {
      localStorage.setItem(WIDTH_KEY, String(widthRef.current));
    } catch {
      // Persisting is best effort.
    }
  }, []);

  const previewText = text?.content ?? "";
  const shownText = previewText.slice(0, MAX_PREVIEW_CHARS);
  const sourceLines = useMemo(
    () => (shownText ? shownText.split("\n") : []),
    [shownText],
  );
  const lineNumbers = useMemo(
    () => sourceLines.map((_, index) => index + 1).join("\n"),
    [sourceLines],
  );

  /**
   * An SVG that declares `width="100%" height="100%"` has no intrinsic size, so
   * an <img> lays it out at 0×0. Derive a box from the viewBox (or an absolute
   * width/height) and let it shrink to the panel width.
   */
  const svgFrame = useMemo(() => {
    if (!isSvg) return null;
    const source = previewText;
    const view = /viewBox\s*=\s*["']([^"']+)["']/i.exec(source)?.[1];
    const root = /<svg\b[^>]*>/i.exec(source)?.[0] ?? "";
    const widthAttr = /(?:^|\s)width\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(root)?.[1];
    const heightAttr = /(?:^|\s)height\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(root)?.[1];

    let ratioWidth = 4;
    let ratioHeight = 3;
    if (view) {
      const parts = view.split(/[\s,]+/).map(Number);
      if (parts.length === 4 && (parts[2] ?? 0) > 0 && (parts[3] ?? 0) > 0) {
        ratioWidth = parts[2] as number;
        ratioHeight = parts[3] as number;
      }
    } else if (widthAttr && heightAttr) {
      ratioWidth = Number(widthAttr);
      ratioHeight = Number(heightAttr);
    }
    if (!(ratioWidth > 0) || !(ratioHeight > 0)) {
      ratioWidth = 4;
      ratioHeight = 3;
    }

    const available = Math.max(120, width - 32);
    const naturalWidth = widthAttr ? Number(widthAttr) : 0;
    let frameWidth =
      naturalWidth > 0 && naturalWidth < available ? naturalWidth : available;
    let frameHeight = frameWidth * (ratioHeight / ratioWidth);
    if (frameHeight > 240) {
      frameHeight = 240;
      frameWidth = frameHeight * (ratioWidth / ratioHeight);
    }
    return { width: Math.round(frameWidth), height: Math.round(frameHeight) };
  }, [isSvg, previewText, width]);

  if (!open) return null;

  const thumbnail = entry ? thumbnailFor(entry, 512) : undefined;
  const parent = entry ? parentPath(entry.path, platform) : null;
  const mediaUrl =
    entry && (isVideo || isAudio || isSvg) ? api.mediaUrl(entry.path) : null;
  const pdfUrl = entry && isPdf ? api.mediaUrl(entry.path) : null;

  const textLines = previewText ? sourceLines.length : null;
  const isMarkdown = Boolean(
    text?.ext && MARKDOWN_EXTS.has(text.ext.toLowerCase()),
  );
  const isOfficeText = Boolean(
    text?.ext && OFFICE_TEXT_EXTS.has(text.ext.toLowerCase()),
  );
  const inArchive = archiveNode;

  const sizeLabel = (() => {
    if (!entry) return "—";
    if (!isDirectory) return formatBytes(entry.size);
    if (inArchive) return "—";
    if (dirSize) {
      return `${formatBytes(dirSize.size)}${dirSize.partial ? "＋" : ""}`;
    }
    return "正在计算…";
  })();

  const subtitle = entry
    ? `${fileKindLabel(entry)}${entry.mtimeMs ? ` · ${formatAgo(entry.mtimeMs)}` : ""}`
    : "";

  const checkerboard = entryExt ? ALPHA_IMAGE_EXTENSIONS.has(entryExt) : false;
  const imageStyle = checkerboard
    ? {
        backgroundImage:
          "repeating-conic-gradient(rgba(0,0,0,0.05) 0% 25%, transparent 0% 50%)",
        backgroundSize: "14px 14px",
      }
    : undefined;

  const copyPath = () => {
    if (!entry) return;
    void navigator.clipboard
      .writeText(entry.path)
      .then(() => notify("已复制路径"))
      .catch(() => notify("复制失败"));
  };

  const copyText = () => {
    if (!previewText) return;
    void navigator.clipboard
      .writeText(previewText)
      .then(() => notify(`已复制 ${previewText.length} 个字符`))
      .catch(() => notify("复制失败"));
  };

  const copySelectionPaths = () => {
    if (selected.length === 0) return;
    void navigator.clipboard
      .writeText(selected.join("\n"))
      .then(() => notify(`已复制 ${selected.length} 个路径`))
      .catch(() => notify("复制失败"));
  };

  const openProperties = () => {
    if (selected.length === 0) return;
    openDialog({ kind: "properties", paths: [...selected] });
  };

  const openAll = () => {
    const files = selectedEntries.filter((item) => item.kind === "file");
    if (files.length > OPEN_ALL_LIMIT) {
      notify(`选中了 ${files.length} 个文件，请在右键菜单中打开`);
      return;
    }
    for (const file of files) void openEntry(file);
    if (files.length === 0) {
      const lastDir = [...selectedEntries]
        .reverse()
        .find((item) => item.kind === "directory");
      if (lastDir) void openEntry(lastDir);
      else notify("没有可打开的项目");
    }
  };

  const totals = (() => {
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    for (const item of selectedEntries) {
      if (item.kind === "directory") dirs += 1;
      else {
        files += 1;
        bytes += item.size;
      }
    }
    return { files, dirs, bytes, missing: selected.length - selectedEntries.length };
  })();

  const sharedParent = (() => {
    if (selected.length === 0) return null;
    const parents = new Set(
      selected.map((path) => parentPath(path, platform) ?? ""),
    );
    return parents.size === 1 ? [...parents][0] || null : null;
  })();

  const childAction = (child: EntryDto): (() => void) | null => {
    if (virtualTree) {
      // Navigating inside an archive only works for folders; files there are
      // opened by browsing, not by a virtual path the shell cannot see.
      return child.kind === "directory" ? () => void navigate(child.path) : null;
    }
    return () => void openEntry(child);
  };

  const hasInlinePreview =
    Boolean(previewText) ||
    isVideo ||
    isAudio ||
    isPdf ||
    isSvg ||
    Boolean(thumbnail) ||
    isDirectory ||
    archiveFile;

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-mac-line bg-mac-chrome/50"
      style={{ width }}
      aria-label="预览"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="调整预览宽度"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="absolute -left-[3px] top-0 z-10 h-full w-[6px] cursor-col-resize"
      />

      <div className="flex h-8 shrink-0 items-center border-b border-mac-line pl-3 pr-2">
        <span className="text-[11.5px] font-medium text-mac-text/70">预览</span>
        <span className="flex-1" />
        <button
          type="button"
          aria-label="关闭预览"
          onClick={() => setPreviewOpen(false)}
          className="grid size-6 place-items-center rounded-[6px] text-mac-text/55 transition-colors duration-100 hover:bg-black/[0.07] hover:text-mac-text dark:hover:bg-white/[0.1]"
        >
          <SFXmark size={11} />
        </button>
      </div>

      {isMulti ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-4 pb-2 pt-4">
            <div className="grid min-h-[110px] place-items-center">
              {selectedEntries.length > 0 ? (
                <div className="flex max-w-full flex-wrap items-center justify-center gap-1">
                  {selectedEntries.slice(0, MULTI_ICON_LIMIT).map((item) => (
                    <FileIcon
                      key={item.path}
                      entry={item}
                      size={44}
                      shellIcon={shellIcons[item.path]}
                    />
                  ))}
                </div>
              ) : (
                <SFFolderFill size={72} className="text-[var(--folder-tint)]" />
              )}
            </div>
            <div className="mt-2 text-center text-[13px] font-medium leading-5 text-mac-text">
              {selected.length} 个项目
            </div>
            <div className="mt-0.5 text-center text-[11px] text-mac-muted">
              {totals.files} 个文件 · {totals.dirs} 个文件夹
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto border-t border-mac-line px-4 py-3">
            <InfoRow
              label="总计"
              value={`${formatBytes(totals.bytes)}${totals.dirs > 0 ? " · 不含文件夹" : ""}`}
              title="只累加文件大小，文件夹未递归计算"
            />
            <InfoRow
              label="位置"
              value={sharedParent ?? "多个位置"}
              mono
            />
            {totals.missing > 0 && (
              <InfoRow
                label="说明"
                value={`${totals.missing} 项不在当前列表中，未计入统计`}
              />
            )}

            <div className="mt-3">
              <SectionTitle
                label="选中的项目"
                hint={`共 ${selected.length} 项`}
              />
              <div className="flex flex-col gap-0.5">
                {selectedEntries.slice(0, MULTI_ROW_LIMIT).map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => selectOnly(item.path)}
                    title={`只选中 ${item.name}`}
                    className={ROW_BUTTON}
                  >
                    <FileIcon
                      entry={item}
                      size={14}
                      shellIcon={shellIcons[item.path]}
                    />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.kind === "file" && (
                      <span className="shrink-0 text-[10.5px] text-mac-muted">
                        {formatBytes(item.size)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {selected.length > MULTI_ROW_LIMIT && (
                <p className="mt-1 px-1 text-[10.5px] text-mac-muted">
                  …以及另外 {selected.length - MULTI_ROW_LIMIT} 项
                </p>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1 border-t border-mac-line px-2 py-1.5">
            <button
              type="button"
              onClick={openAll}
              className={`${PANEL_BUTTON} font-medium text-mac-blue`}
            >
              打开
            </button>
            <button
              type="button"
              onClick={openProperties}
              className={`${PANEL_BUTTON} text-mac-muted`}
            >
              简介
            </button>
            <button
              type="button"
              onClick={copySelectionPaths}
              className={`${PANEL_BUTTON} text-mac-muted`}
            >
              复制路径
            </button>
          </div>
        </div>
      ) : !entry ? (
        <div className="grid flex-1 place-items-center px-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <SFEye size={22} className="text-mac-muted" />
            <p className="text-[12px] leading-5 text-mac-muted">
              选择一个项目查看预览
            </p>
            <p className="text-[11px] leading-5 text-mac-muted/70">
              支持图片、视频、音频、PDF、文本、压缩包与文件夹
            </p>
            <p className="text-[10.5px] text-mac-muted/60">
              空格键开关面板 · 拖动左侧边缘调整宽度
            </p>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-4 pb-2 pt-4">
            <div className="grid min-h-[110px] place-items-center">
              {isPdf && pdfUrl && !mediaFailed ? (
                <iframe
                  key={pdfUrl}
                  src={pdfUrl}
                  title={entry.name}
                  onError={() => setMediaFailed(true)}
                  className="h-[320px] w-full rounded-md border border-mac-line bg-white"
                />
              ) : isVideo && mediaUrl && !mediaFailed ? (
                <video
                  src={mediaUrl}
                  controls
                  preload="metadata"
                  onLoadedMetadata={(event) =>
                    setDuration(event.currentTarget.duration)
                  }
                  onError={() => setMediaFailed(true)}
                  className="max-h-[220px] w-full rounded-md bg-black/40"
                />
              ) : isAudio && mediaUrl && !mediaFailed ? (
                <div className="flex w-full flex-col items-center gap-3">
                  <FileIcon entry={entry} size={60} shellIcon={shellIcon} />
                  <audio
                    src={mediaUrl}
                    controls
                    preload="metadata"
                    onLoadedMetadata={(event) =>
                      setDuration(event.currentTarget.duration)
                    }
                    onError={() => setMediaFailed(true)}
                    className="w-full"
                  />
                </div>
              ) : isSvg && mediaUrl && svgFrame && !imageFailed ? (
                <button
                  type="button"
                  title="双击用默认应用打开"
                  onDoubleClick={() => void openEntry(entry)}
                  className="grid max-w-full place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-mac-blue/50"
                >
                  <img
                    src={mediaUrl}
                    alt=""
                    width={svgFrame.width}
                    height={svgFrame.height}
                    draggable={false}
                    onError={() => setImageFailed(true)}
                    className="max-w-full rounded-md object-contain"
                    style={{
                      width: svgFrame.width,
                      height: svgFrame.height,
                      ...imageStyle,
                    }}
                  />
                </button>
              ) : thumbnail && !imageFailed ? (
                <button
                  type="button"
                  title="双击用默认应用打开"
                  onDoubleClick={() => void openEntry(entry)}
                  className="grid max-w-full place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-mac-blue/50"
                >
                  <img
                    src={thumbnail}
                    alt=""
                    draggable={false}
                    onError={() => setImageFailed(true)}
                    className="max-h-[240px] w-auto max-w-full rounded-md object-contain"
                    style={imageStyle}
                  />
                </button>
              ) : isDirectory ? (
                <SFFolderFill
                  size={96}
                  className="text-[var(--folder-tint)]"
                />
              ) : (
                <FileIcon entry={entry} size={96} shellIcon={shellIcon} />
              )}
            </div>

            <div className="mt-2 w-full break-words text-center text-[13px] font-medium leading-5 text-mac-text">
              {entry.name}
            </div>
            <div className="mt-0.5 text-center text-[11px] text-mac-muted">
              {subtitle}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto border-t border-mac-line px-4 py-3">
            <InfoRow label="种类" value={fileKindLabel(entry)} />
            <InfoRow
              label="大小"
              value={sizeLabel}
              title={
                dirSize
                  ? `${dirSize.files} 个文件 · ${dirSize.dirs} 个文件夹${dirSize.partial ? "（已达扫描上限）" : ""}`
                  : undefined
              }
            />
            {isDirectory && dirSize && (
              <InfoRow
                label="包含"
                value={`${dirSize.files} 个文件 · ${dirSize.dirs} 个文件夹`}
              />
            )}
            {archiveFile && childCount > 0 && (
              <InfoRow label="归档" value={`${childCount} 个项目`} />
            )}
            {info?.image && (
              <InfoRow
                label="尺寸"
                value={`${info.image.width} × ${info.image.height}${
                  info.image.format ? ` · ${info.image.format.toUpperCase()}` : ""
                }`}
              />
            )}
            {duration !== null && Number.isFinite(duration) && (
              <InfoRow label="时长" value={formatDuration(duration)} />
            )}
            {info?.pdf?.pages && (
              <InfoRow label="页数" value={`${info.pdf.pages} 页`} />
            )}
            {previewText && (
              <InfoRow
                label="文本"
                value={`${textLines ?? 0} 行 · ${previewText.length} 字符`}
              />
            )}
            {text?.encoding === "utf8" && previewText && (
              <InfoRow label="编码" value="UTF-8" />
            )}
            {info?.readonly && <InfoRow label="属性" value="只读" />}
            {info?.isLink && <InfoRow label="属性" value="链接" />}
            <InfoRow label="修改" value={formatDate(entry.mtimeMs)} />
            {info && info.birthtimeMs !== info.mtimeMs && (
              <InfoRow label="创建" value={formatDate(info.birthtimeMs)} />
            )}
            <InfoRow label="位置" value={parent ?? entry.path} mono />

            {listable && children && (
              children.length > 0 ? (
                <div className="mt-3">
                  <div className="flex items-baseline gap-1">
                    <SectionTitle
                      label={virtualTree ? "归档内容" : "内容"}
                      hint={`共 ${childCount} 项`}
                    />
                    {virtualTree && (
                      <button
                        type="button"
                        onClick={() => void openEntry(entry)}
                        className="ml-auto flex items-center gap-0.5 text-[10.5px] text-mac-blue hover:underline"
                      >
                        浏览
                        <SFChevronRight size={8} />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {children.map((child) => {
                      const action = childAction(child);
                      const content = (
                        <>
                          <FileIcon entry={child} size={14} />
                          <span className="min-w-0 flex-1 truncate">{child.name}</span>
                          {child.kind === "file" && (
                            <span className="shrink-0 text-[10.5px] text-mac-muted">
                              {formatBytes(child.size)}
                            </span>
                          )}
                        </>
                      );
                      return action ? (
                        <button
                          key={child.path}
                          type="button"
                          onClick={action}
                          title={child.name}
                          className={ROW_BUTTON}
                        >
                          {content}
                        </button>
                      ) : (
                        <div
                          key={child.path}
                          title={child.name}
                          className="flex w-full items-center gap-1.5 px-1 py-0.5 text-[11.5px] text-mac-text"
                        >
                          {content}
                        </div>
                      );
                    })}
                  </div>
                  {childCount > children.length && (
                    <p className="mt-1 px-1 text-[10.5px] text-mac-muted">
                      …以及另外 {childCount - children.length} 项
                    </p>
                  )}
                </div>
              ) : (
                <div className="mt-3">
                  <SectionTitle
                    label={virtualTree ? "归档内容" : "内容"}
                    hint="空"
                  />
                  <p className="px-1 text-[11px] text-mac-muted">
                    {virtualTree ? "这个归档里没有项目" : "这个文件夹是空的"}
                  </p>
                </div>
              )
            )}

            {textLoading && (
              <div className="mt-4 text-[11px] text-mac-muted">正在读取内容…</div>
            )}

            {previewText && (
              <div className="mt-4">
                <div className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-mac-muted">
                  <span className="whitespace-nowrap font-medium">内容预览</span>
                  <span className="whitespace-nowrap text-[10.5px] text-mac-muted/70">
                    {textLines ?? 0} 行
                  </span>
                  {text?.truncated && (
                    <span className="whitespace-nowrap text-[10.5px] text-mac-muted/70">
                      仅显示开头
                    </span>
                  )}
                  {isOfficeText && (
                    <span className="whitespace-nowrap text-[10.5px] text-mac-muted/70">
                      仅提取文字
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    {isMarkdown && (
                      <span className="flex rounded-[5px] bg-black/[0.05] p-0.5 dark:bg-white/[0.08]">
                        <button
                          type="button"
                          onClick={() => setTextMode("render")}
                          className={textMode === "render" ? TAB_ON : TAB_OFF}
                        >
                          预览
                        </button>
                        <button
                          type="button"
                          onClick={() => setTextMode("source")}
                          className={textMode === "source" ? TAB_ON : TAB_OFF}
                        >
                          源码
                        </button>
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => setWrap((value) => !value)}
                      title={wrap ? "关闭自动换行，显示行号" : "自动换行，方便读长段落"}
                      className={clsx(
                        "whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10.5px] transition-colors",
                        wrap
                          ? "bg-black/[0.07] text-mac-text dark:bg-white/[0.12]"
                          : "text-mac-muted hover:bg-black/[0.06] hover:text-mac-text dark:hover:bg-white/[0.08]",
                      )}
                    >
                      换行
                    </button>
                    <button
                      type="button"
                      onClick={copyText}
                      title="复制全部内容"
                      className="whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10.5px] text-mac-muted transition-colors hover:bg-black/[0.06] hover:text-mac-text dark:hover:bg-white/[0.08]"
                    >
                      复制
                    </button>
                  </span>
                </div>
                {isMarkdown && textMode === "render" ? (
                  <div className="max-h-[420px] select-text overflow-y-auto rounded-md bg-black/[0.03] px-3 py-2.5 text-[12px] leading-6 text-mac-text dark:bg-white/[0.04]">
                    <Markdown text={shownText} />
                  </div>
                ) : (
                  <div className="max-h-[420px] overflow-auto rounded-md bg-black/[0.04] dark:bg-white/[0.05]">
                    {wrap ? (
                      <pre className="select-text whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-5 text-mac-text/90">
                        {shownText}
                      </pre>
                    ) : (
                      <div className="flex w-max min-w-full">
                        <pre className="sticky left-0 z-10 shrink-0 select-none border-r border-mac-line/60 bg-mac-surface px-2 py-2 text-right font-mono text-[10px] leading-5 text-mac-muted/60">
                          {lineNumbers}
                        </pre>
                        <pre className="select-text px-2.5 py-2 font-mono text-[11px] leading-5 text-mac-text/90">
                          {shownText}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {!hasInlinePreview && !textLoading && (
              <p className="mt-4 text-[11px] leading-5 text-mac-muted">
                没有可显示的内容预览，点击「打开」用默认应用查看。
              </p>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1 border-t border-mac-line px-2 py-1.5">
            <button
              type="button"
              onClick={() => void openEntry(entry)}
              className={`${PANEL_BUTTON} font-medium text-mac-blue`}
            >
              打开
            </button>
            <button
              type="button"
              onClick={openProperties}
              className={`${PANEL_BUTTON} text-mac-muted`}
            >
              简介
            </button>
            <button
              type="button"
              onClick={() => void reveal(entry.path)}
              className={`${PANEL_BUTTON} text-mac-muted`}
            >
              定位
            </button>
            <button
              type="button"
              onClick={copyPath}
              title="复制完整路径"
              className={`${PANEL_BUTTON} text-mac-muted`}
            >
              复制路径
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
