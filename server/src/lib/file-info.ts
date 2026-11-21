import {
  fromNativePath,
  fs,
  toNativePathAlways,
} from "./native-fs.js";
import path from "node:path";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import type { DirectorySizeDto, FileInfoDto } from "@oriel/shared";
import { statOrThrow } from "./fs-utils.js";

/**
 * Extra metadata used by the preview panel: recursive folder sizes, image
 * dimensions, PDF page counts and the MIME type used for inline playback.
 */

const SIZE_TIMEOUT_MS = 15_000;
const SIZE_MAX_ENTRIES = 500_000;
const PDF_SCAN_BYTES = 8 * 1024 * 1024;
const SIZE_CACHE_TTL_MS = 60_000;
const SIZE_CACHE_ENTRIES = 600;

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "jfif",
  "webp",
  "gif",
  "bmp",
  "avif",
  "tif",
  "tiff",
  "svg",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  // Video
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  aac: "audio/aac",
  wma: "audio/x-ms-wma",
  aiff: "audio/aiff",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  // Documents the browser can render itself
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

export function mimeFor(target: string): string {
  const ext = path.extname(target).slice(1).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/**
 * Directory sizes run in worker threads using synchronous fs calls.
 *
 * The async version spent most of its time bouncing through the libuv thread
 * pool (four threads by default): 84k files took >4s. A worker with sync
 * syscalls does the same tree in ~0.9s and keeps the main thread free to answer
 * listing and thumbnail requests.
 *
 * One worker walks a whole batch of folders (the list view asks for ~24 at a
 * time) instead of one process per folder, which removes the ~8ms thread
 * startup from every single cell.
 */
const SIZE_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");

const { targets, deadline, maxEntries } = workerData;
const results = [];

for (const target of targets) {
  let size = 0;
  let files = 0;
  let dirs = 0;
  let scanned = 0;
  let partial = false;
  const stack = [target];

  while (stack.length > 0) {
    if (Date.now() > deadline || scanned >= maxEntries) {
      partial = true;
      break;
    }

    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      partial = true;
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        dirs += 1;
        stack.push(path.join(dir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;

      scanned += 1;
      try {
        size += fs.lstatSync(path.join(dir, entry.name)).size;
        files += 1;
      } catch {}

      // The budget is checked per directory; this keeps it honest for very
      // wide folders without paying Date.now() twice per entry.
      if ((scanned & 1023) === 0 && Date.now() > deadline) {
        partial = true;
        stack.length = 0;
        break;
      }
    }
  }

  results.push({ path: target, size, files, dirs, partial });
}

parentPort.postMessage(results);
`;

const sizeCache = new Map<string, { at: number; value: DirectorySizeDto }>();
const sizeInflight = new Map<string, Promise<DirectorySizeDto>>();
/** Never more than this many walks at once: each one pins a CPU core. */
const SIZE_MAX_WORKERS = 3;
let activeWorkers = 0;
const workerQueue: Array<() => void> = [];

async function acquireWorker(): Promise<void> {
  if (activeWorkers < SIZE_MAX_WORKERS) {
    activeWorkers += 1;
    return;
  }
  await new Promise<void>((resolve) => workerQueue.push(resolve));
  activeWorkers += 1;
}

function releaseWorker(): void {
  activeWorkers -= 1;
  const next = workerQueue.shift();
  if (next) next();
}

function rememberSize(value: DirectorySizeDto): void {
  // True LRU: a hit moves the entry to the end of the insertion order.
  sizeCache.delete(value.path);
  if (sizeCache.size >= SIZE_CACHE_ENTRIES) {
    const oldest = sizeCache.keys().next().value;
    if (oldest) sizeCache.delete(oldest);
  }
  sizeCache.set(value.path, { at: Date.now(), value });
}

function runSizeWorker(targets: string[]): Promise<DirectorySizeDto[]> {
  return new Promise((resolve) => {
    const fallback = targets.map((target) => ({
      path: target,
      size: 0,
      files: 0,
      dirs: 0,
      partial: true,
    }));

    // The worker joins children onto these paths, so the long-path prefix has
    // to be applied before the length grows; results are mapped back below.
    const roots = targets.map((target) => toNativePathAlways(target));

    let worker: Worker;
    try {
      worker = new Worker(SIZE_WORKER_SOURCE, {
        eval: true,
        workerData: {
          targets: roots,
          deadline: Date.now() + SIZE_TIMEOUT_MS,
          maxEntries: SIZE_MAX_ENTRIES,
        },
      });
    } catch (error) {
      console.error("[size-worker] create failed:", error);
      resolve(fallback);
      return;
    }

    const finish = (value: DirectorySizeDto[]) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(value);
    };

    const timer = setTimeout(() => finish(fallback), SIZE_TIMEOUT_MS + 2000);

    worker.once("message", (message: DirectorySizeDto[]) =>
      finish(message.map((value) => ({ ...value, path: fromNativePath(value.path) }))),
    );
    worker.once("error", (error) => {
      console.error("[size-worker] failed:", error);
      finish(fallback);
    });
  });
}

/**
 * Recursive folder sizes with caching and request coalescing: the same folder
 * requested from the list view and the preview panel is walked only once.
 * Several folders share up to `SIZE_MAX_WORKERS` worker threads.
 */
async function measureUncached(targets: string[]): Promise<DirectorySizeDto[]> {
  const slices: string[][] = Array.from({ length: Math.min(SIZE_MAX_WORKERS, targets.length) }, () => []);
  targets.forEach((target, index) => slices[index % slices.length]?.push(target));

  await acquireWorker();
  try {
    const batches = await Promise.all(slices.filter((slice) => slice.length > 0).map(runSizeWorker));
    return batches.flat();
  } finally {
    releaseWorker();
  }
}

/** Resolves directory sizes for a batch, reading from cache where possible. */
export async function measureDirectories(
  targets: string[],
): Promise<Record<string, DirectorySizeDto>> {
  const result: Record<string, DirectorySizeDto> = {};
  const need: string[] = [];

  for (const target of targets) {
    const cached = sizeCache.get(target);
    if (cached && Date.now() - cached.at < SIZE_CACHE_TTL_MS) {
      rememberSize(cached.value);
      result[target] = cached.value;
      continue;
    }

    const running = sizeInflight.get(target);
    if (running) {
      const value = await running.catch(() => null);
      if (value) result[target] = value;
      continue;
    }

    need.push(target);
  }

  if (need.length === 0) return result;

  const batch = measureUncached(need);
  for (const target of need) {
    const single = batch
      .then((values) => values.find((value) => value.path === target))
      .then((value) => value ?? { path: target, size: 0, files: 0, dirs: 0, partial: true })
      .then((value) => {
        rememberSize(value);
        return value;
      })
      .finally(() => sizeInflight.delete(target));
    sizeInflight.set(target, single);
  }

  const values = await Promise.all(
    need.map((target) => sizeInflight.get(target) as Promise<DirectorySizeDto>),
  );
  need.forEach((target, index) => {
    const value = values[index];
    if (value) result[target] = value;
  });

  return result;
}

export async function measureDirectory(
  target: string,
): Promise<DirectorySizeDto> {
  const sizes = await measureDirectories([target]);
  return (
    sizes[target] ?? { path: target, size: 0, files: 0, dirs: 0, partial: true }
  );
}

async function countPdfPages(target: string): Promise<number | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(target, "r");
    const stat = await handle.stat();
    const length = Math.min(stat.size, PDF_SCAN_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const text = buffer.toString("latin1");
    const matches = text.match(/\/Type\s*\/Page[^s]/g);
    return matches ? matches.length : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readFileInfo(target: string): Promise<FileInfoDto> {
  const stat = await statOrThrow(target);
  const info: FileInfoDto = {
    path: target,
    kind: stat.isDirectory() ? "directory" : "file",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    birthtimeMs: stat.birthtimeMs || stat.mtimeMs,
    readonly: (stat.mode & 0o222) === 0,
    isLink: stat.isSymbolicLink(),
  };

  if (info.kind === "directory") return info;

  const ext = path.extname(target).slice(1).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) {
    try {
      const metadata = await sharp(target, { failOn: "none" }).metadata();
      if (metadata.width && metadata.height) {
        info.image = {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format,
        };
      }
    } catch {
      // Not a decodable image — no dimensions to report.
    }
  }

  if (ext === "pdf") {
    const pages = await countPdfPages(target);
    if (pages) info.pdf = { pages };
  }

  return info;
}
