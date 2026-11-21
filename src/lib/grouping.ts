import type { EntryDto } from "@oriel/shared";

/**
 * Explorer-style "group by". Entries keep the active sort order inside each
 * bucket; only the bucket order is fixed, which is what makes a grouped list
 * predictable.
 */

export type GroupKey = "none" | "name" | "kind" | "date" | "size";

export const GROUP_LABELS: Record<GroupKey, string> = {
  none: "不分组",
  name: "名称",
  kind: "种类",
  date: "修改日期",
  size: "大小",
};

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "ico", "svg", "avif",
  "tif", "tiff", "heic", "psd", "raw", "cr2", "nef",
]);
const VIDEO_EXTENSIONS = new Set([
  "mp4", "m4v", "webm", "mkv", "mov", "avi", "wmv", "flv", "mpg", "mpeg", "ts",
]);
const AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "flac", "m4a", "ogg", "opus", "aac", "wma", "aiff", "ape",
]);
const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "rtf",
  "csv", "odt", "ods", "odp", "epub", "mobi", "azw3", "djvu", "chm",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "iso", "cab", "tgz",
]);
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "html", "htm", "css",
  "scss", "less", "py", "rs", "go", "java", "c", "h", "cpp", "hpp", "cs", "rb",
  "php", "sh", "ps1", "bat", "cmd", "yml", "yaml", "toml", "ini", "cfg", "sql",
  "vue", "svelte", "lua", "dart", "kt", "swift",
]);

export interface EntryGroup {
  /** Stable id used as the React key. */
  id: string;
  label: string;
  entries: EntryDto[];
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function kindBucket(entry: EntryDto): { id: string; label: string } {
  if (entry.kind === "directory") return { id: "folder", label: "文件夹" };
  const ext = entry.ext;
  if (IMAGE_EXTENSIONS.has(ext)) return { id: "image", label: "图像" };
  if (VIDEO_EXTENSIONS.has(ext)) return { id: "video", label: "影片" };
  if (AUDIO_EXTENSIONS.has(ext)) return { id: "audio", label: "音乐" };
  if (DOCUMENT_EXTENSIONS.has(ext)) return { id: "document", label: "文档" };
  if (ARCHIVE_EXTENSIONS.has(ext)) return { id: "archive", label: "压缩包" };
  if (CODE_EXTENSIONS.has(ext)) return { id: "code", label: "代码" };
  if (!ext) return { id: "plain", label: "文件" };
  return { id: "other", label: `${ext.toUpperCase()} 文件` };
}

function dateBucket(entry: EntryDto, now: number): { id: string; label: string } {
  const today = startOfDay(now);
  const day = startOfDay(entry.mtimeMs || now);
  if (day >= today) return { id: "today", label: "今天" };
  if (day >= today - DAY) return { id: "yesterday", label: "昨天" };
  if (day >= today - 7 * DAY) return { id: "week", label: "本周" };
  if (day >= today - 30 * DAY) return { id: "month", label: "本月" };
  const year = new Date(now).getFullYear();
  if (new Date(day).getFullYear() === year) return { id: "year", label: "今年" };
  return { id: "older", label: "更早" };
}

function sizeBucket(entry: EntryDto): { id: string; label: string } {
  if (entry.kind === "directory") return { id: "folder", label: "文件夹" };
  if (entry.size === 0) return { id: "empty", label: "空文件" };
  const mb = 1024 * 1024;
  if (entry.size < 16 * 1024) return { id: "tiny", label: "小于 16 KB" };
  if (entry.size < mb) return { id: "small", label: "16 KB – 1 MB" };
  if (entry.size < 100 * mb) return { id: "medium", label: "1 – 100 MB" };
  if (entry.size < 1024 * mb) return { id: "large", label: "100 MB – 1 GB" };
  return { id: "huge", label: "大于 1 GB" };
}

function nameBucket(entry: EntryDto): { id: string; label: string } {
  const first = entry.name.trim().charAt(0).toUpperCase();
  if (/[A-Z]/.test(first)) return { id: `letter-${first}`, label: first };
  if (/[0-9]/.test(first)) return { id: "digit", label: "0 – 9" };
  if (!first) return { id: "other", label: "其他" };
  return { id: "cjk", label: "其他" };
}

/** Bucket order, so "今天/昨天/本周…" never comes back shuffled. */
const ORDER: Record<GroupKey, string[]> = {
  none: [],
  name: [
    ...Array.from({ length: 26 }, (_, index) => `letter-${String.fromCharCode(65 + index)}`),
    "digit",
    "cjk",
    "other",
  ],
  kind: ["folder", "image", "video", "audio", "document", "archive", "code", "plain", "other"],
  date: ["today", "yesterday", "week", "month", "year", "older"],
  size: ["folder", "empty", "tiny", "small", "medium", "large", "huge"],
};

export function groupEntries(
  entries: EntryDto[],
  key: GroupKey,
  now = Date.now(),
): EntryGroup[] | null {
  if (key === "none") return null;

  const buckets = new Map<string, EntryGroup>();

  for (const entry of entries) {
    const bucket =
      key === "kind"
        ? kindBucket(entry)
        : key === "date"
          ? dateBucket(entry, now)
          : key === "size"
            ? sizeBucket(entry)
            : nameBucket(entry);

    const existing = buckets.get(bucket.id);
    if (existing) existing.entries.push(entry);
    else buckets.set(bucket.id, { id: bucket.id, label: bucket.label, entries: [entry] });
  }

  const order = ORDER[key];
  return [...buckets.values()].sort((a, b) => {
    const left = order.indexOf(a.id);
    const right = order.indexOf(b.id);
    return (left < 0 ? order.length : left) - (right < 0 ? order.length : right);
  });
}
