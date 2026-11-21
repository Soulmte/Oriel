import type { Dirent } from "node:fs";
import path from "node:path";
import type { EntryDto, PreviewResponse } from "@oriel/shared";
import {
  PREVIEW_BYTE_LIMIT,
  SEARCH_BUDGET_MS,
  SEARCH_RESULT_LIMIT,
} from "@oriel/shared";
import { ApiError, fromFsError } from "../errors.js";
import { createReadStream, fs } from "./native-fs.js";
import { isSamePath, isWithin, parentOf } from "./paths.js";

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "$recycle.bin",
  "system volume information",
  ".cache",
  // Whole-disk scans drown in these; they almost never hold user documents.
  "winsxs",
  "driverstore",
  "installer",
  "servicing",
  "assembly",
  "softwaredistribution",
  "$windows.~bt",
  "$windows.~ws",
  "windows.old",
]);

/**
 * Explored after the user-facing branches when a search starts at a drive root,
 * so `C:\Users\…` is reached long before `C:\Windows\…`.
 */
const SYSTEM_FIRST_LEVEL = new Set([
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "perflogs",
  "recovery",
  "msocache",
  "config.msi",
  "$recycle.bin",
  "system volume information",
  "intel",
  "amd",
  "nvidia",
]);

/** Hard stop for one search, independent of the time budget. */
const MAX_SCAN_ENTRIES = 800_000;

/**
 * Node does not expose Windows file attributes, so hide the well-known system
 * entries by name when the user has not asked to show hidden files. Dotfiles
 * are handled separately and behave the same on every platform.
 */
const WINDOWS_SYSTEM_ENTRIES = new Set([
  "$recycle.bin",
  "$winreagent",
  "system volume information",
  "pagefile.sys",
  "hiberfil.sys",
  "swapfile.sys",
  "config.msi",
  "bootmgr",
  "bootnxt",
  "desktop.ini",
  "thumbs.db",
  "dumpstack.log",
  "dumpstack.log.tmp",
]);

export function isHiddenEntryName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    name.startsWith(".") ||
    lower.startsWith("ntuser.dat") ||
    lower.startsWith("$windows.") ||
    WINDOWS_SYSTEM_ENTRIES.has(lower)
  );
}

export function compareEntries(a: EntryDto, b: EntryDto): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return collator.compare(a.name, b.name);
}

export async function statOrThrow(target: string) {
  try {
    return await fs.stat(target);
  } catch (error) {
    throw fromFsError(error, target);
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function toEntry(
  fullPath: string,
  name: string,
  isDirHint: boolean,
): Promise<EntryDto | null> {
  try {
    const lstat = await fs.lstat(fullPath);
    const isLink = lstat.isSymbolicLink();
    // `readdir` reports Windows junctions and symlinks as files, so follow the
    // link once to find out whether it actually points at a directory.
    const stat = isLink ? await fs.stat(fullPath) : lstat;
    const isDir = isDirHint || stat.isDirectory();
    return {
      name,
      path: fullPath,
      kind: isDir ? "directory" : "file",
      size: isDir ? 0 : stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs || stat.mtimeMs,
      ext: isDir ? "" : path.extname(name).slice(1).toLowerCase(),
      hidden: isHiddenEntryName(name),
      readonly: (stat.mode & 0o222) === 0,
      isLink,
    };
  } catch {
    // Broken links, permission errors and vanished entries should not break
    // the whole listing.
    return null;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index] as T);
      }
    }),
  );

  return results;
}

export async function readDirectory(
  directory: string,
  showHidden: boolean,
): Promise<EntryDto[]> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw fromFsError(error, directory);
  }

  const visible = showHidden
    ? dirents
    : dirents.filter((dirent) => !isHiddenEntryName(dirent.name));

  const entries = await mapLimit(visible, 32, (dirent) =>
    toEntry(path.join(directory, dirent.name), dirent.name, dirent.isDirectory()),
  );

  return entries
    .filter((entry): entry is EntryDto => entry !== null)
    .sort(compareEntries);
}

export async function listDirectory(directory: string, showHidden: boolean) {
  const stat = await statOrThrow(directory);
  if (!stat.isDirectory()) {
    throw ApiError.badRequest("NOT_A_DIRECTORY", "该路径不是文件夹");
  }
  return {
    path: directory,
    parent: parentOf(directory),
    entries: await readDirectory(directory, showHidden),
  };
}

/**
 * Stats a handful of children by name. The file watcher reports which entries
 * changed, so the client can patch a 20k-entry listing with a dozen stats
 * instead of re-reading the whole folder.
 */
export async function readEntriesByName(
  directory: string,
  names: string[],
): Promise<EntryDto[]> {
  const unique = [...new Set(names)]
    .filter((name) => name && !/[\\/]/.test(name))
    .slice(0, 400);
  if (unique.length === 0) return [];

  const entries = await mapLimit(unique, 16, (name) =>
    toEntry(path.join(directory, name), name, false),
  );
  return entries.filter((entry): entry is EntryDto => entry !== null);
}

export interface SearchOptions {
  showHidden: boolean;
  limit?: number;
  /** Wall-clock budget; the scan stops and reports `timedOut` when it expires. */
  budgetMs?: number;
  signal?: AbortSignal;
  /** Receives matches in small batches so the UI can render them live. */
  onMatches?: (entries: EntryDto[]) => void;
  /** Coarse progress: how many directory entries were visited so far. */
  onProgress?: (scanned: number) => void;
}

export interface SearchResult {
  entries: EntryDto[];
  scanned: number;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Recursive name search.
 *
 * Depth-first, because a whole-disk breadth-first walk spends its whole budget
 * on shallow system folders (`WinSxS` alone holds ~39k entries) and never
 * reaches `C:\Users`. The traversal is cancellable, time-boxed, and reports
 * matches as it finds them instead of after the last directory.
 */
export async function searchDirectory(
  root: string,
  query: string,
  options: SearchOptions,
): Promise<SearchResult> {
  const normalizedQuery = query.trim().toLowerCase();
  const limit = Math.min(Math.max(options.limit ?? SEARCH_RESULT_LIMIT, 1), 1000);
  const deadline = Date.now() + (options.budgetMs ?? SEARCH_BUDGET_MS);

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  /** System branches held back until the user-facing ones are exhausted. */
  const deferred: Array<{ dir: string; depth: number }> = [];
  const results: EntryDto[] = [];
  let batch: EntryDto[] = [];
  let lastFlush = Date.now();
  let scanned = 0;
  let truncated = false;
  let timedOut = false;

  const flush = (force = false) => {
    if (batch.length === 0) return;
    if (!force && batch.length < 24 && Date.now() - lastFlush < 120) return;
    options.onMatches?.(batch);
    batch = [];
    lastFlush = Date.now();
  };

  while (stack.length > 0 || deferred.length > 0) {
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    if (options.signal?.aborted) {
      truncated = true;
      break;
    }
    if (Date.now() > deadline) {
      truncated = true;
      timedOut = true;
      break;
    }
    if (scanned >= MAX_SCAN_ENTRIES) {
      truncated = true;
      break;
    }

    const current = stack.pop() ?? deferred.pop();
    if (!current) break;

    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      // Permission denied / vanished: keep walking the rest of the tree.
      continue;
    }

    for (const dirent of dirents) {
      scanned += 1;
      if (scanned >= MAX_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
      if (!options.showHidden && isHiddenEntryName(dirent.name)) continue;

      const name = dirent.name;
      const lower = name.toLowerCase();
      // Junctions and symlinks report as files here, so they are never
      // descended into: that is what keeps a whole-disk scan loop-free.
      const isDir = dirent.isDirectory();

      if (lower.includes(normalizedQuery)) {
        const entry = await toEntry(path.join(current.dir, name), name, isDir);
        if (entry) {
          results.push(entry);
          batch.push(entry);
          if (results.length >= limit) {
            truncated = true;
            break;
          }
        }
      }

      if (!isDir || SKIP_DIRECTORIES.has(lower)) continue;

      const child = { dir: path.join(current.dir, name), depth: current.depth + 1 };
      if (current.depth === 0 && SYSTEM_FIRST_LEVEL.has(lower)) deferred.push(child);
      else stack.push(child);
    }

    if (Date.now() > deadline) {
      truncated = true;
      timedOut = true;
    }

    flush();
    options.onProgress?.(scanned);
    if (timedOut) break;
  }

  flush(true);

  return {
    entries: results.sort(compareEntries),
    scanned,
    truncated,
    timedOut,
  };
}

export async function readPreview(target: string): Promise<PreviewResponse> {
  const stat = await statOrThrow(target);
  if (stat.isDirectory()) {
    throw ApiError.badRequest("NOT_A_FILE", "文件夹没有文本预览");
  }

  const readSize = Math.min(stat.size, PREVIEW_BYTE_LIMIT);
  const buffer = Buffer.alloc(readSize);

  if (readSize > 0) {
    const handle = await fs.open(target, "r");
    try {
      await handle.read(buffer, 0, readSize, 0);
    } finally {
      await handle.close();
    }
  }

  const isBinary = buffer.includes(0);
  // `stream: true` holds back a trailing partial UTF-8 sequence instead of
  // turning the 512 KB cut into a replacement character.
  const text = isBinary
    ? null
    : stripBom(new TextDecoder("utf-8").decode(buffer, { stream: true }));

  return {
    path: target,
    name: path.basename(target),
    ext: path.extname(target).slice(1).toLowerCase(),
    encoding: isBinary ? "binary" : "utf8",
    content: text,
    size: stat.size,
    truncated: stat.size > readSize,
  };
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** Open a file or folder with the OS default handler. */
export async function openWithSystem(target: string): Promise<void> {
  const { spawn } = await import("node:child_process");

  if (process.platform === "win32") {
    const child = spawn("explorer.exe", [target], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [target], { detached: true, stdio: "ignore" });
  child.unref();
}

/** Reveal in the native file manager (Explorer on Windows). */
export async function revealInSystem(target: string): Promise<void> {
  const { spawn } = await import("node:child_process");

  if (process.platform === "win32") {
    const child = spawn("explorer.exe", [`/select,${target}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "darwin" ? ["-R", target] : [path.dirname(target)];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function createFolder(parentPath: string, name: string): Promise<string> {
  const parentStat = await statOrThrow(parentPath);
  if (!parentStat.isDirectory()) {
    throw ApiError.badRequest("NOT_A_DIRECTORY", "目标不是文件夹");
  }

  const destination = path.join(parentPath, name);
  if (await pathExists(destination)) {
    throw ApiError.conflict(`“${name}” 已存在`);
  }

  try {
    await fs.mkdir(destination);
  } catch (error) {
    throw fromFsError(error, destination);
  }
  return destination;
}

/** Creates an empty file; "new text document" from the toolbar. */
export async function createFile(parentPath: string, name: string): Promise<string> {
  const parentStat = await statOrThrow(parentPath);
  if (!parentStat.isDirectory()) {
    throw ApiError.badRequest("NOT_A_DIRECTORY", "目标不是文件夹");
  }

  const destination = path.join(parentPath, name);
  if (await pathExists(destination)) {
    throw ApiError.conflict(`“${name}” 已存在`);
  }

  try {
    await fs.writeFile(destination, "", { flag: "wx" });
  } catch (error) {
    throw fromFsError(error, destination);
  }
  return destination;
}

/** Opens a terminal in the given folder (Windows Terminal when available). */
export async function openTerminal(target: string): Promise<void> {
  const { spawn } = await import("node:child_process");

  if (process.platform !== "win32") {
    const child = spawn(
      process.platform === "darwin" ? "open" : "x-terminal-emulator",
      process.platform === "darwin" ? ["-a", "Terminal", target] : [],
      { cwd: target, detached: true, stdio: "ignore" },
    );
    child.unref();
    return;
  }

  // `wt` ships with Windows 11; fall back to a plain PowerShell window.
  const child = spawn("wt.exe", ["-d", target], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.on("error", () => {
    const fallback = spawn(
      "powershell.exe",
      ["-NoExit", "-Command", `Set-Location -LiteralPath '${target.replace(/'/g, "''")}'`],
      { detached: true, stdio: "ignore", windowsHide: false, cwd: target },
    );
    fallback.unref();
  });
  child.unref();
}

export async function renameEntry(
  target: string,
  newName: string,
): Promise<string> {
  const destination = path.join(path.dirname(target), newName);
  if (isSamePath(target, destination)) return target;

  await statOrThrow(target);
  if (await pathExists(destination)) {
    throw ApiError.conflict(`“${newName}” 已存在`);
  }

  try {
    await fs.rename(target, destination);
  } catch (error) {
    throw fromFsError(error, destination);
  }
  return destination;
}

export async function copyEntries(
  sources: string[],
  targetDirectory: string,
): Promise<string[]> {
  const stat = await statOrThrow(targetDirectory);
  if (!stat.isDirectory()) {
    throw ApiError.badRequest("NOT_A_DIRECTORY", "目标不是文件夹");
  }

  const created: string[] = [];
  for (const source of sources) {
    await statOrThrow(source);
    const destination = path.join(targetDirectory, path.basename(source));

    if (isSamePath(source, destination)) continue;
    if (isWithin(source, destination)) {
      throw ApiError.badRequest("INVALID_TARGET", "不能将文件夹复制到其自身内部");
    }
    if (await pathExists(destination)) {
      throw ApiError.conflict(`“${path.basename(source)}” 已存在`);
    }

    try {
      await fs.cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
      created.push(destination);
    } catch (error) {
      throw fromFsError(error, destination);
    }
  }
  return created;
}

export async function moveEntries(
  sources: string[],
  targetDirectory: string,
): Promise<string[]> {
  const stat = await statOrThrow(targetDirectory);
  if (!stat.isDirectory()) {
    throw ApiError.badRequest("NOT_A_DIRECTORY", "目标不是文件夹");
  }

  const moved: string[] = [];
  for (const source of sources) {
    await statOrThrow(source);
    const destination = path.join(targetDirectory, path.basename(source));

    if (isSamePath(source, destination)) continue;
    if (isWithin(source, destination)) {
      throw ApiError.badRequest("INVALID_TARGET", "不能将文件夹移动到其自身内部");
    }
    if (await pathExists(destination)) {
      throw ApiError.conflict(`“${path.basename(source)}” 已存在`);
    }

    try {
      await fs.rename(source, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EXDEV") throw fromFsError(error, destination);

      // Cross-volume move: copy then remove the source.
      try {
        await fs.cp(source, destination, {
          recursive: true,
          force: false,
          errorOnExist: true,
          preserveTimestamps: true,
        });
        await fs.rm(source, { recursive: true, force: false });
      } catch (copyError) {
        throw fromFsError(copyError, destination);
      }
    }

    moved.push(destination);
  }
  return moved;
}

export function createDownloadStream(target: string) {
  return createReadStream(target);
}
