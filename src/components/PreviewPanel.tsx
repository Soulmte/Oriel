import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@heroui/react";
import type {
  EntryDto,
  FileInfoDto,
  PreviewResponse,
} from "@oriel/shared";
import { clsx } from "clsx";
import {
  SFArrowUpRightSquare,
  SFEye,
  SFFolderFill,
  SFSquareOnSquare,
  SFXmark,
} from "sf-symbols-lib/dualtone";
import { useExplorer } from "../store/explorer";
import { FileIcon, thumbnailFor } from "../lib/fileIcons";
import { api } from "../lib/api";
import { isArchivePath } from "../lib/archivePath";
import { fileKindLabel, formatBytes, formatDate, parentPath } from "../lib/format";

/** Types that never carry readable text, so we skip the preview request. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "jfif", "gif", "webp", "avif", "bmp", "ico", "heic",
  "tif", "tiff", "psd", "ai", "eps", "fig", "sketch", "xd",
  "mp4", "mkv", "mov", "avi", "webm", "flv", "wmv", "m4v", "mpg", "mpeg",
  "mp3", "wav", "flac", "m4a", "ogg", "opus", "aac", "wma", "aiff",
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "cab", "deb", "rpm",
  "exe", "msi", "msix", "msixbundle", "appx", "apk", "ipa", "dll", "sys",
  "iso", "img", "vhd", "vhdx", "dmg",
  "pdf", "doc", "docx", "docm", "dot", "dotx", "rtf", "odt", "pages",
  "xls", "xlsx", "xlsm", "xlsb", "ods", "numbers",
  "ppt", "pptx", "pptm", "pps", "ppsx", "odp", "key",
  "epub", "mobi", "azw", "azw3", "fb2", "djvu", "chm",
  "ttf", "otf", "woff", "woff2", "eot",
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mov", "mkv", "avi", "wmv", "flv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "m4a", "ogg", "opus", "aac", "wma", "aiff"]);

const MAX_PREVIEW_CHARS = 20000;
/** Quiet footer button: text only, surface on hover, like a macOS pane. */
const PANEL_BUTTON =
  "flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-[6px] px-2 text-[11.5px] " +
  "transition-colors duration-100 hover:bg-black/[0.06] dark:hover:bg-white/[0.08] " +
  "outline-none focus-visible:ring-2 focus-visible:ring-mac-blue/50";
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
          "min-w-0 flex-1 break-words text-[12px] text-mac-text",
          mono && "font-mono text-[11px]",
        )}
        title={title ?? value}
      >
        {value}
      </span>
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

  const [width, setWidth] = useState(readWidth);
  const layoutEpoch = useExplorer((state) => state.layoutEpoch);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const [info, setInfo] = useState<FileInfoDto | null>(null);
  const [text, setText] = useState<PreviewResponse | null>(null);
  const [textLoading, setTextLoading] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  const entry = useMemo<EntryDto | null>(() => {
    if (selected.length === 0) return null;
    const source = query.trim() && results ? results : entries;
    const last = selected[selected.length - 1];
    return source.find((item) => item.path === last) ?? null;
  }, [entries, results, query, selected]);

  const entryPath = entry?.path ?? "";
  const entryExt = entry?.ext ?? "";
  const isDirectory = entry?.kind === "directory";
  const isVideo = VIDEO_EXTENSIONS.has(entryExt);
  const isAudio = AUDIO_EXTENSIONS.has(entryExt);
  // WebView2 ships the Chromium PDF viewer, so a PDF only needs a URL.
  const isPdf = entryExt === "pdf";
  const skipText = !entry || isDirectory || BINARY_EXTENSIONS.has(entryExt);

  const requestFolderSizes = useExplorer((state) => state.requestFolderSizes);
  const dirSize = useExplorer((state) =>
    entryPath ? state.folderSizes[entryPath] : undefined,
  );

  // Reset per-selection view state.
  useEffect(() => {
    setMediaFailed(false);
    setImageFailed(false);
    setDuration(null);
  }, [entryPath]);

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

  if (!open) return null;

  const thumbnail = entry ? thumbnailFor(entry, 512) : undefined;
  const parent = entry ? parentPath(entry.path, platform) : null;
  const mediaUrl = entry && (isVideo || isAudio) ? api.mediaUrl(entry.path) : null;
  const pdfUrl = entry && isPdf ? api.mediaUrl(entry.path) : null;

  const textLines = text?.content ? text.content.split("\n").length : null;

  const inArchive = isArchivePath(entry?.path ?? "");

  const sizeLabel = (() => {
    if (!entry) return "—";
    if (!isDirectory) return formatBytes(entry.size);
    if (inArchive) return "—";
    if (dirSize) {
      return `${formatBytes(dirSize.size)}${dirSize.partial ? "＋" : ""}`;
    }
    return "正在计算…";
  })();

  const copyPath = () => {
    if (!entry) return;
    void navigator.clipboard
      .writeText(entry.path)
      .then(() => notify("已复制路径"))
      .catch(() => notify("复制失败"));
  };

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

      {!entry ? (
        <div className="grid flex-1 place-items-center px-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <SFEye size={22} className="text-mac-muted" />
            <p className="text-[12px] leading-5 text-mac-muted">
              选择一个项目查看预览
            </p>
            <p className="text-[11px] text-mac-muted/70">
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
                  className="h-[300px] w-full rounded-md border border-mac-line bg-white"
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
                <div className="w-full">
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
              ) : thumbnail && !imageFailed ? (
                <img
                  src={thumbnail}
                  alt=""
                  draggable={false}
                  onError={() => setImageFailed(true)}
                  className="max-h-[240px] w-auto max-w-full rounded-md object-contain"
                />
              ) : isDirectory ? (
                <SFFolderFill size={96} className="text-[#3d9bff]" />
              ) : (
                <FileIcon entry={entry} size={96} />
              )}
            </div>

            <div className="mt-2 w-full break-words text-center text-[13px] font-medium leading-5 text-mac-text">
              {entry.name}
            </div>
            {selected.length > 1 && (
              <div className="mt-0.5 text-center text-[11px] text-mac-muted">
                已选择 {selected.length} 个项目，显示最后一个
              </div>
            )}
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
            {text?.content && (
              <InfoRow
                label="文本"
                value={`${textLines ?? 0} 行 · ${text.content.length} 字符`}
              />
            )}
            {info?.readonly && <InfoRow label="属性" value="只读" />}
            {info?.isLink && <InfoRow label="属性" value="链接" />}
            <InfoRow label="修改" value={formatDate(entry.mtimeMs)} />
            {info && info.birthtimeMs !== info.mtimeMs && (
              <InfoRow label="创建" value={formatDate(info.birthtimeMs)} />
            )}
            <InfoRow label="位置" value={parent ?? entry.path} mono />

            {textLoading && (
              <div className="mt-4 text-[11px] text-mac-muted">正在读取内容…</div>
            )}

            {text?.content && (
              <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-mac-muted">
                  <span>内容预览</span>
                  {text.truncated && <span>仅显示开头</span>}
                </div>
                <pre className="max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.04] p-2.5 font-mono text-[11px] leading-5 text-mac-text/90 dark:bg-white/[0.05]">
                  {text.content.slice(0, MAX_PREVIEW_CHARS)}
                </pre>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1 border-t border-mac-line px-2 py-1.5">
            <button
              type="button"
              onClick={() => void openEntry(entry)}
              className={`${PANEL_BUTTON} text-mac-text`}
            >
              打开
            </button>
            <span className="h-4 w-px shrink-0 bg-mac-line" />
            <button
              type="button"
              onClick={() => void reveal(entry.path)}
              className={`${PANEL_BUTTON} text-mac-muted`}
            >
              <SFArrowUpRightSquare size={12} />
              定位
            </button>
            <button
              type="button"
              onClick={copyPath}
              className={`${PANEL_BUTTON} text-mac-muted`}
            >
              <SFSquareOnSquare size={12} />
              复制路径
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
