import type { EntryDto, SortDirection, SortKey } from "@oriel/shared";
import { archiveParent } from "./archivePath";

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  const digits = index === 0 ? 0 : value >= 100 ? 0 : decimals;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatDate(ms: number): string {
  if (!ms) return "—";
  const date = new Date(ms);
  const now = new Date();

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const wasYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (wasYesterday) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;

  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

const KIND_LABELS: Record<string, string> = {
  txt: "文本文稿",
  md: "Markdown 文稿",
  pdf: "PDF 文稿",
  doc: "Word 文稿",
  docx: "Word 文稿",
  xls: "Excel 表格",
  xlsx: "Excel 表格",
  csv: "CSV 表格",
  ppt: "PowerPoint 演示文稿",
  pptx: "PowerPoint 演示文稿",
  epub: "EPUB 电子书",
  mobi: "MOBI 电子书",
  azw: "Kindle 电子书",
  azw3: "Kindle 电子书",
  fb2: "FictionBook 电子书",
  djvu: "DjVu 文档",
  chm: "CHM 帮助文档",
  log: "日志文件",
  ttf: "TrueType 字体",
  otf: "OpenType 字体",
  woff: "Web 字体",
  woff2: "Web 字体",
  png: "PNG 图像",
  jpg: "JPEG 图像",
  jpeg: "JPEG 图像",
  gif: "GIF 图像",
  webp: "WebP 图像",
  svg: "SVG 图像",
  bmp: "BMP 图像",
  avif: "AVIF 图像",
  tif: "TIFF 图像",
  tiff: "TIFF 图像",
  psd: "Photoshop 文稿",
  mp3: "MP3 音频",
  wav: "WAV 音频",
  flac: "FLAC 音频",
  mp4: "MP4 影片",
  mkv: "MKV 影片",
  mov: "QuickTime 影片",
  webm: "WebM 影片",
  avi: "AVI 影片",
  m4a: "M4A 音频",
  ogg: "Ogg 音频",
  opus: "Opus 音频",
  zip: "ZIP 归档",
  rar: "RAR 归档",
  "7z": "7-Zip 归档",
  tar: "TAR 归档",
  gz: "Gzip 归档",
  iso: "光盘镜像",
  vhd: "虚拟磁盘",
  vhdx: "虚拟磁盘",
  lnk: "快捷方式",
  url: "Internet 快捷方式",
  exe: "Windows 应用程序",
  msi: "Windows 安装程序",
  ts: "TypeScript 文件",
  tsx: "TypeScript React 文件",
  js: "JavaScript 文件",
  jsx: "JavaScript React 文件",
  json: "JSON 文件",
  html: "HTML 文稿",
  css: "CSS 样式表",
};

/**
 * Name shown in the grid/list. Hiding extensions is a display preference — the
 * real name (and renames) always keep it.
 */
export function displayName(entry: EntryDto, showExtensions: boolean): string {
  if (showExtensions || entry.kind === "directory" || !entry.ext) return entry.name;
  const suffix = `.${entry.ext}`;
  return entry.name.toLowerCase().endsWith(suffix)
    ? entry.name.slice(0, -suffix.length)
    : entry.name;
}

export function fileKindLabel(entry: EntryDto): string {
  if (entry.kind === "directory") return "文件夹";
  if (!entry.ext) return "文件";
  return KIND_LABELS[entry.ext] ?? `${entry.ext.toUpperCase()} 文件`;
}

export function basename(target: string): string {
  const normalized = target.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || normalized;
}

export function parentPath(target: string, platform: string): string | null {
  if (!target) return null;
  if (target.startsWith("archive://")) {
    return archiveParent(target);
  }
  if (platform === "win32") {
    const normalized = target.replace(/\\+$/, "");
    if (/^[a-zA-Z]:$/.test(normalized)) return null;
    if (/^\\\\[^\\]+\\[^\\]+$/.test(normalized)) return null;
    const index = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
    if (index < 0) return null;
    const parent = normalized.slice(0, index);
    if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\`;
    return parent || null;
  }
  if (target === "/") return null;
  const normalized = target.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

export interface PathSegment {
  label: string;
  path: string;
}

export function splitPath(target: string, platform: string): PathSegment[] {
  if (!target) return [];

  if (platform === "win32") {
    if (/^\\\\[^\\]+\\[^\\]+/.test(target)) {
      const [server, share, ...rest] = target.replace(/\\+$/, "").split("\\").filter(Boolean);
      const segments: PathSegment[] = [];
      let acc = `\\\\${server}\\${share}`;
      segments.push({ label: `${server}\\${share}`, path: acc });
      for (const part of rest) {
        acc = `${acc}\\${part}`;
        segments.push({ label: part, path: acc });
      }
      return segments;
    }

    const match = /^([a-zA-Z]:)[\\/]/.exec(target);
    if (!match) return [{ label: target, path: target }];

    const drive = match[1] as string;
    const root = `${drive}\\`;
    const rest = target.slice(root.length).split(/[\\/]/).filter(Boolean);
    const segments: PathSegment[] = [{ label: drive, path: root }];
    let acc = root;
    for (const part of rest) {
      acc = acc.endsWith("\\") ? acc + part : `${acc}\\${part}`;
      segments.push({ label: part, path: acc });
    }
    return segments;
  }

  const segments: PathSegment[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of target.split("/").filter(Boolean)) {
    acc = `${acc}/${part}`;
    segments.push({ label: part, path: acc });
  }
  return segments;
}

export function samePath(
  a: string,
  b: string,
  platform: string,
): boolean {
  if (platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

export function startsWithPath(
  target: string,
  parent: string,
  platform: string,
): boolean {
  const left = platform === "win32" ? target.toLowerCase() : target;
  const right = platform === "win32" ? parent.toLowerCase() : parent;
  return left === right || left.startsWith(right.endsWith("\\") || right.endsWith("/") ? right : `${right}${platform === "win32" ? "\\" : "/"}`);
}

export function compareEntriesForSort(
  a: EntryDto,
  b: EntryDto,
  key: SortKey,
  direction: SortDirection,
): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  const factor = direction === "asc" ? 1 : -1;

  switch (key) {
    case "date":
      return (a.mtimeMs - b.mtimeMs) * factor;
    case "size":
      return (a.size - b.size) * factor;
    case "kind": {
      const left = a.kind === "directory" ? "" : a.ext;
      const right = b.kind === "directory" ? "" : b.ext;
      return collator.compare(left, right) * factor;
    }
    case "name":
    default:
      return collator.compare(a.name, b.name) * factor;
  }
}

export function sortEntries(
  entries: EntryDto[],
  key: SortKey,
  direction: SortDirection,
): EntryDto[] {
  return [...entries].sort((a, b) => compareEntriesForSort(a, b, key, direction));
}

/**
 * The grid, the list and the store's selection math all sort the same array.
 * Caching by array identity + sort field means 87k entries are ordered once per
 * change instead of once per view.
 */
const sortCache = new WeakMap<EntryDto[], Map<string, EntryDto[]>>();

export function sortEntriesCached(
  entries: EntryDto[],
  key: SortKey,
  direction: SortDirection,
): EntryDto[] {
  let byKey = sortCache.get(entries);
  if (!byKey) {
    byKey = new Map();
    sortCache.set(entries, byKey);
  }

  const cacheKey = `${key}:${direction}`;
  const hit = byKey.get(cacheKey);
  if (hit) return hit;

  const sorted = sortEntries(entries, key, direction);
  byKey.set(cacheKey, sorted);
  return sorted;
}
