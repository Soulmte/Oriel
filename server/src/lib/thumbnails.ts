import { createHash } from "node:crypto";
import { fs } from "./native-fs.js";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ApiError } from "../errors.js";
import { statOrThrow } from "./fs-utils.js";

/**
 * Image thumbnails.
 *
 * Rendering a folder of photos must not block the UI, so every thumbnail is
 * generated once, cached on disk by (path, mtime, size, requested width) and
 * served straight from memory afterwards. Generation itself is capped by a
 * small semaphore so a folder with hundreds of images cannot saturate the CPU.
 */

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

/** Files above this size are skipped: decoding them would be a memory hazard. */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_MEMORY_ENTRIES = 320;
const MAX_CONCURRENT_RENDERS = 3;
const CACHE_DIRECTORY = path.join(os.tmpdir(), "oriel-thumbnails");
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const THUMBNAIL_MIN_SIZE = 32;
export const THUMBNAIL_MAX_SIZE = 512;

const memory = new Map<string, Buffer>();
/**
 * Decode failures, so a folder of broken images is not retried on every scroll.
 * Keyed like the memory cache, so touching the file clears the verdict.
 */
const failed = new Set<string>();
const MAX_FAILED_ENTRIES = 500;
let activeRenders = 0;
const waiting: Array<() => void> = [];
let prepared: Promise<void> | null = null;

function rememberFailure(key: string): void {
  if (failed.size >= MAX_FAILED_ENTRIES) {
    const oldest = failed.values().next().value;
    if (oldest) failed.delete(oldest);
  }
  failed.add(key);
}

function remember(key: string, buffer: Buffer): void {
  if (memory.size >= MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
  memory.set(key, buffer);
}

async function acquire(): Promise<void> {
  if (activeRenders < MAX_CONCURRENT_RENDERS) {
    activeRenders += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  activeRenders += 1;
}

function release(): void {
  activeRenders -= 1;
  const next = waiting.shift();
  if (next) next();
}

async function prepare(): Promise<void> {
  if (!prepared) {
    prepared = (async () => {
      await fs.mkdir(CACHE_DIRECTORY, { recursive: true });
      // Best effort: drop stale entries so the temp folder does not grow forever.
      const entries = await fs.readdir(CACHE_DIRECTORY).catch(() => []);
      const deadline = Date.now() - CACHE_MAX_AGE_MS;
      await Promise.all(
        entries.slice(0, 500).map(async (name) => {
          const file = path.join(CACHE_DIRECTORY, name);
          const stat = await fs.stat(file).catch(() => null);
          if (stat && stat.mtimeMs < deadline) {
            await fs.unlink(file).catch(() => undefined);
          }
        }),
      );
    })().catch(() => undefined);
  }
  await prepared;
}

export function isThumbnailable(ext: string): boolean {
  return IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

export function normalizeThumbnailSize(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 256;
  return Math.min(
    THUMBNAIL_MAX_SIZE,
    Math.max(THUMBNAIL_MIN_SIZE, Math.round(parsed)),
  );
}

/**
 * Thumbnail for an in-memory image (archive entries, where there is no path to
 * stat). Cached in the same memory map, keyed by a caller-provided identity.
 */
export async function getThumbnailFromBuffer(
  buffer: Buffer,
  identity: string,
  size: number,
): Promise<Buffer> {
  const key = createHash("sha1").update(`${identity}|${size}`).digest("hex");

  const cached = memory.get(key);
  if (cached) return cached;
  if (failed.has(key)) throw ApiError.badRequest("THUMBNAIL_FAILED", "无法读取该图片");

  await acquire();
  try {
    const output = await sharp(buffer, { failOn: "none" })
      .rotate()
      .resize({
        width: size,
        height: size,
        fit: "contain",
        withoutEnlargement: true,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 74, effort: 3 })
      .toBuffer();

    remember(key, output);
    return output;
  } catch {
    rememberFailure(key);
    throw ApiError.badRequest("THUMBNAIL_FAILED", "无法读取该图片");
  } finally {
    release();
  }
}

export async function getThumbnail(
  target: string,
  size: number,
): Promise<Buffer> {
  const ext = path.extname(target).slice(1).toLowerCase();
  if (!isThumbnailable(ext)) {
    throw ApiError.badRequest("NOT_AN_IMAGE", "该文件不是图片");
  }

  const stat = await statOrThrow(target);
  if (stat.isDirectory()) {
    throw ApiError.badRequest("NOT_A_FILE", "文件夹没有缩略图");
  }
  if (stat.size > MAX_SOURCE_BYTES) {
    throw ApiError.badRequest("FILE_TOO_LARGE", "图片过大，无法生成缩略图");
  }

  const key = createHash("sha1")
    .update(`${target}|${Math.round(stat.mtimeMs)}|${stat.size}|${size}`)
    .digest("hex");

  const cached = memory.get(key);
  if (cached) return cached;

  if (failed.has(key)) {
    throw ApiError.badRequest("THUMBNAIL_FAILED", "无法读取该图片");
  }

  await prepare();
  const cacheFile = path.join(CACHE_DIRECTORY, `${key}.webp`);

  const onDisk = await fs.readFile(cacheFile).catch(() => null);
  if (onDisk) {
    remember(key, onDisk);
    return onDisk;
  }

  await acquire();
  try {
    const buffer = await sharp(target, { failOn: "none" })
      .rotate()
      .resize({
        width: size,
        height: size,
        fit: "contain",
        withoutEnlargement: true,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality: 74, effort: 3 })
      .toBuffer();

    remember(key, buffer);
    void fs.writeFile(cacheFile, buffer).catch(() => undefined);
    return buffer;
  } catch {
    rememberFailure(key);
    throw ApiError.badRequest("THUMBNAIL_FAILED", "无法读取该图片");
  } finally {
    release();
  }
}
