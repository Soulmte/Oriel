import type { FastifyPluginAsync } from "fastify";
import { promises as fs, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import trash from "trash";
import type {
  DirectorySizeDto,
  EntryDto,
  ListResponse,
  PreviewResponse,
  SearchDoneEvent,
  SearchMatchEvent,
  SearchResponse,
} from "@oriel/shared";
import {
  ERROR_CODES,
  PREVIEW_BYTE_LIMIT,
  SEARCH_BUDGET_MS,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_RESULT_LIMIT,
} from "@oriel/shared";
import { ApiError, fromFsError } from "../errors.js";
import {
  batchRenameEntries,
  copyEntries,
  createDownloadStream,
  createFile,
  createFolder,
  isHiddenEntryName,
  listDirectory,
  moveEntries,
  openTerminal,
  openWithSystem,
  pathExists,
  readPreview,
  readEntriesByName,
  renameEntry,
  revealInSystem,
  searchDirectory,
  statOrThrow,
} from "../lib/fs-utils.js";
import { buildOfficeTemplate } from "../lib/ooxml.js";
import type { OfficeTemplate } from "../lib/ooxml.js";
import {
  assertSafeToDelete,
  normalizePath,
  validateEntryName,
} from "../lib/paths.js";
import {
  createArchiveStream,
  extractArchive,
  listArchive,
  readArchiveEntry,
  statArchiveEntry,
} from "../lib/archives.js";
import { isArchivePath, parseArchivePath } from "../lib/archive-path.js";
import { getThumbnailFromBuffer } from "../lib/thumbnails.js";
import {
  emptyRecycleBin,
  listRecycleBin,
  purgeRecycleItems,
  restoreRecycleItems,
} from "../lib/recycle-bin.js";
import { getShellIcons } from "../lib/shell-icons.js";
import { setFileClipboard, readFileClipboard } from "../lib/clipboard.js";
import { corsHeaders } from "../lib/cors.js";
import { createReadStream } from "../lib/native-fs.js";
import { getThumbnail, normalizeThumbnailSize } from "../lib/thumbnails.js";
import { measureDirectories, measureDirectory, mimeFor, readFileInfo } from "../lib/file-info.js";
import {
  cancelTask,
  createTransfer,
  findConflicts,
  getTask,
  onTaskProgress,
  pauseTask,
  resumeTask,
  retryTask,
} from "../lib/tasks.js";
import type { ConflictPolicy, TransferKind } from "../lib/tasks.js";

type Query = Record<string, unknown>;
type Body = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function flag(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

/**
 * Read routes accept both real paths and `archive://` virtual paths; write
 * routes refuse the latter because an archive is read-only.
 */
function resolveTarget(value: unknown): string {
  if (typeof value === "string" && isArchivePath(value.trim())) {
    return value.trim();
  }
  return normalizePath(value);
}

/** Rejects a raw client value that points inside an archive. */
function assertNotArchive(value: unknown): void {
  if (typeof value === "string" && isArchivePath(value.trim())) {
    assertWritable(value.trim());
  }
}

function assertNoArchiveItems(value: unknown): void {
  if (Array.isArray(value)) value.forEach(assertNotArchive);
}

function assertWritable(target: string): void {
  if (isArchivePath(target)) {
    throw ApiError.forbidden(
      ERROR_CODES.unsafeOperation,
      "归档内容只读，请先解压到文件夹再修改",
    );
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw ApiError.badRequest("INVALID_BODY", "缺少要操作的项目");
  }
  return value.map((item) => normalizePath(item));
}

export const fsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/fs/list", async (request): Promise<ListResponse> => {
    const query = request.query as Query;
    const target = resolveTarget(query.path);
    if (isArchivePath(target)) {
      const listing = await listArchive(target);
      if (flag(query.showHidden)) return listing;
      return {
        ...listing,
        entries: listing.entries.filter((entry) => !entry.hidden),
      };
    }
    return listDirectory(target, flag(query.showHidden));
  });

  app.get("/fs/stat", async (request) => {
    const query = request.query as Query;
    const target = resolveTarget(query.path);
    if (isArchivePath(target)) return statArchiveEntry(target);
    try {
      const stat = await statOrThrow(target);
      const entry: EntryDto = {
        name: path.basename(target),
        path: target,
        kind: stat.isDirectory() ? "directory" : "file",
        size: stat.isDirectory() ? 0 : stat.size,
        mtimeMs: stat.mtimeMs,
        birthtimeMs: stat.birthtimeMs || stat.mtimeMs,
        ext: stat.isDirectory() ? "" : path.extname(target).slice(1).toLowerCase(),
        hidden: isHiddenEntryName(path.basename(target)),
        readonly: (stat.mode & 0o222) === 0,
        isLink: stat.isSymbolicLink(),
      };
      return entry;
    } catch (error) {
      throw fromFsError(error, target);
    }
  });

  /**
   * Stats only the named children of a folder. Used by the watcher to patch the
   * current listing instead of re-reading it after every change.
   */
  app.post("/fs/entries", async (request) => {
    const body = (request.body ?? {}) as Body;
    const directory = normalizePath(body.path);
    const names = Array.isArray(body.names)
      ? body.names.filter((item): item is string => typeof item === "string")
      : [];
    if (names.length === 0) return { entries: [] };
    return { entries: await readEntriesByName(directory, names) };
  });

  app.get("/fs/preview", async (request): Promise<PreviewResponse> => {
    const query = request.query as Query;
    const target = resolveTarget(query.path);

    if (isArchivePath(target)) {
      const limit = Math.min(PREVIEW_BYTE_LIMIT, 512 * 1024);
      const { buffer, size } = await readArchiveEntry(target, limit);
      const binary = buffer.includes(0);
      const innerName = parseArchivePath(target).inner;
      return {
        path: target,
        name: innerName.split("\\").pop() ?? innerName,
        ext: path.extname(innerName).slice(1).toLowerCase(),
        encoding: binary ? "binary" : "utf8",
        content: binary ? null : new TextDecoder("utf-8").decode(buffer, { stream: true }),
        size,
        truncated: size > buffer.length,
      };
    }

    return readPreview(target);
  });

  app.post("/fs/icons", async (request) => {
    const body = (request.body ?? {}) as Body;
    const paths = Array.isArray(body.paths) ? body.paths : [];
    const normalized = paths
      .slice(0, 120)
      .map((item) => normalizePath(item));
    return { icons: await getShellIcons(normalized) };
  });

  app.get("/fs/thumbnail", async (request, reply) => {
    const query = request.query as Query;
    const target = resolveTarget(query.path);
    const size = normalizeThumbnailSize(query.size);

    const buffer = isArchivePath(target)
      ? await getThumbnailFromBuffer(
          (await readArchiveEntry(target, 32 * 1024 * 1024)).buffer,
          target,
          size,
        )
      : await getThumbnail(target, size);

    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("Content-Length", String(buffer.length));
    reply.type("image/webp");
    return reply.send(buffer);
  });

  app.get("/fs/info", async (request) => {
    const query = request.query as Query;
    const target = resolveTarget(query.path);

    if (isArchivePath(target)) {
      const entry = await statArchiveEntry(target);
      return {
        path: target,
        kind: entry.kind === "directory" ? "directory" : "file",
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        birthtimeMs: entry.birthtimeMs,
        readonly: true,
        isLink: false,
      };
    }

    return readFileInfo(target);
  });

  app.get("/fs/size", async (request) => {
    const query = request.query as Query;
    const target = normalizePath(query.path);
    const stat = await statOrThrow(target);
    if (!stat.isDirectory()) {
      throw ApiError.badRequest(ERROR_CODES.notADirectory, "该路径不是文件夹");
    }
    return measureDirectory(target);
  });

  /** Batch folder sizes for a whole listing; the batch shares up to 3 workers. */
  app.post("/fs/sizes", async (request) => {
    const body = (request.body ?? {}) as Body;
    const paths = Array.isArray(body.paths) ? body.paths.slice(0, 120) : [];
    if (paths.length === 0) return { sizes: {} };

    const normalized = paths.map((item) => normalizePath(item));
    const directories: string[] = [];

    await Promise.all(
      normalized.map(async (target) => {
        try {
          const stat = await statOrThrow(target);
          if (stat.isDirectory()) directories.push(target);
        } catch {
          // Vanished or unreadable folders are simply skipped.
        }
      }),
    );

    return { sizes: await measureDirectories(directories) };
  });

  /** Inline media stream with byte-range support so <video> can seek. */
  app.get("/fs/media", async (request, reply) => {
    const query = request.query as Query;
    const target = resolveTarget(query.path);
    if (isArchivePath(target)) {
      throw ApiError.badRequest(
        "ARCHIVE_MEDIA_UNSUPPORTED",
        "归档内的音视频需要先解压才能播放",
      );
    }
    const stat = await statOrThrow(target);
    if (stat.isDirectory()) {
      throw ApiError.badRequest("NOT_A_FILE", "不能预览文件夹");
    }

    const total = stat.size;
    const mime = mimeFor(target);
    const range = request.headers.range;

    reply.header("Accept-Ranges", "bytes");
    // Inline so the built-in PDF viewer can embed it instead of downloading.
    reply.header("Content-Disposition", "inline");

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : total - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
          const last = Math.min(end, total - 1);
          reply.code(206);
          reply.header("Content-Range", `bytes ${start}-${last}/${total}`);
          reply.header("Content-Length", String(last - start + 1));
          reply.type(mime);
          return reply.send(createReadStream(target, { start, end: last }));
        }
        reply.code(416).header("Content-Range", `bytes */${total}`);
        return reply.send();
      }
    }

    reply.header("Content-Length", String(total));
    reply.type(mime);
    return reply.send(createReadStream(target));
  });

  /** Expands ~, %VAR% and $VAR so the address bar accepts what people type. */
  app.get("/fs/resolve", async (request) => {
    const query = request.query as Query;
    let raw = text(query.path).trim();
    if (!raw) throw ApiError.badRequest(ERROR_CODES.invalidPath, "缺少路径");

    if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
      raw = path.join(os.homedir(), raw.slice(1).replace(/^[\\/]/, ""));
    }

    raw = raw.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match);
    raw = raw.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (match, braced: string | undefined, plain: string | undefined) =>
        process.env[braced ?? plain ?? ""] ?? match,
    );

    if (process.platform === "win32") raw = raw.replace(/\//g, "\\");

    const resolved = normalizePath(raw);
    let exists = true;
    try {
      await statOrThrow(resolved);
    } catch {
      exists = false;
    }
    return { path: resolved, exists };
  });

  /**
   * Server-sent events: directory changes for the watched path plus every
   * transfer task update. One stream per window keeps the UI in sync without
   * polling.
   */
  app.get("/events", async (request, reply) => {
    const query = request.query as Query;
    let watchPath: string | null = null;
    try {
      if (typeof query.watch === "string" && query.watch.trim()) {
        watchPath = normalizePath(query.watch);
      }
    } catch {
      watchPath = null;
    }

    reply.hijack();
    const res = reply.raw;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...corsHeaders(request.headers.origin),
    });
    res.write(": connected\n\n");

    const send = (event: string, data: unknown) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // The client went away mid-write; cleanup runs on close.
      }
    };

    const unsubscribe = onTaskProgress((task) => send("task", task));

    let watcher: FSWatcher | null = null;
    let timer: NodeJS.Timeout | null = null;
    /** Names reported inside the current debounce window. */
    const changedNames = new Set<string>();

    if (watchPath) {
      try {
        watcher = watch(watchPath, { persistent: false });
        watcher.on("change", (_event, filename) => {
          // Windows always reports a name; the odd platform that does not falls
          // back to an empty list, which tells the client to re-read the folder.
          if (filename) changedNames.add(String(filename));
          if (timer) return;
          timer = setTimeout(() => {
            timer = null;
            const names = [...changedNames];
            changedNames.clear();
            send("fs-change", { path: watchPath, names });
          }, 150);
        });
        watcher.on("error", () => undefined);
      } catch {
        watcher = null;
      }
    }

    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // ignore
      }
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      watcher?.close();
      unsubscribe();
    };

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);

    return reply;
  });

  /**
   * Mirrors the app's clipboard into the Windows clipboard so the copied files
   * can be pasted into other programs (QQ, Explorer, Word…).
   */
  app.post("/fs/clipboard", async (request) => {
    const body = (request.body ?? {}) as Body;
    const paths = stringArray(body.paths);
    let count: number;
    try {
      count = await setFileClipboard(paths, flag(body.cut));
    } catch (error) {
      throw ApiError.badRequest(
        "CLIPBOARD_FAILED",
        `写入系统剪贴板失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (count === 0) {
      throw ApiError.badRequest("CLIPBOARD_EMPTY", "没有可复制的项目");
    }
    return { ok: true, count };
  });

  /** Reads the file list on the system clipboard (copy from Explorer, QQ…). */
  app.get("/fs/clipboard", async () => {
    try {
      return await readFileClipboard();
    } catch {
      // A clipboard held open by another process is not an error worth showing.
      return { paths: [], cut: false };
    }
  });

  app.post("/fs/conflicts", async (request) => {
    const body = (request.body ?? {}) as Body;
    const sources = stringArray(body.sources);
    const target = normalizePath(body.target);
    return { conflicts: await findConflicts(sources, target) };
  });

  app.post("/fs/transfer", async (request) => {
    const body = (request.body ?? {}) as Body;
    assertNoArchiveItems(body.sources);
    assertNotArchive(body.target);
    const kind: TransferKind = body.kind === "move" ? "move" : "copy";
    const sources = stringArray(body.sources);
    const target = normalizePath(body.target);
    const requested = typeof body.policy === "string" ? body.policy : "rename";
    const policy: ConflictPolicy = (
      ["overwrite", "skip", "rename", "keep-both"] as const
    ).includes(requested as ConflictPolicy)
      ? (requested as ConflictPolicy)
      : "rename";

    const stat = await statOrThrow(target);
    if (!stat.isDirectory()) {
      throw ApiError.badRequest(ERROR_CODES.notADirectory, "目标必须是文件夹");
    }
    for (const source of sources) await statOrThrow(source);

    return createTransfer(kind, sources, target, policy);
  });

  app.get("/fs/tasks/:id", async (request) => {
    const params = request.params as Record<string, string>;
    const task = getTask(params.id);
    if (!task) throw ApiError.notFound("任务不存在");
    return task;
  });

  app.post("/fs/tasks/:id/cancel", async (request) => {
    const params = request.params as Record<string, string>;
    return { cancelled: cancelTask(params.id) };
  });

  app.post("/fs/tasks/:id/pause", async (request) => {
    const params = request.params as Record<string, string>;
    return { paused: pauseTask(params.id) };
  });

  app.post("/fs/tasks/:id/resume", async (request) => {
    const params = request.params as Record<string, string>;
    return { resumed: resumeTask(params.id) };
  });

  app.post("/fs/tasks/:id/retry", async (request) => {
    const params = request.params as Record<string, string>;
    const task = retryTask(params.id);
    if (!task) throw ApiError.notFound("该任务没有可重试的请求");
    return task;
  });

  app.get("/fs/search", async (request): Promise<SearchResponse> => {
    const query = request.query as Query;
    const target = normalizePath(query.path);
    const searchText = text(query.q).trim();

    if (searchText.length < SEARCH_MIN_QUERY_LENGTH) {
      throw ApiError.badRequest("INVALID_QUERY", "请输入至少 1 个字符");
    }

    const stat = await statOrThrow(target);
    if (!stat.isDirectory()) {
      throw ApiError.badRequest(ERROR_CODES.notADirectory, "搜索起点必须是文件夹");
    }

    const limitValue = Number(query.limit ?? SEARCH_RESULT_LIMIT);
    const limit = Number.isFinite(limitValue) ? limitValue : SEARCH_RESULT_LIMIT;

    // Dropping the connection (the user typed another character) stops the walk.
    const controller = new AbortController();
    request.raw.on("close", () => controller.abort());

    const result = await searchDirectory(target, searchText, {
      showHidden: flag(query.showHidden),
      limit,
      signal: controller.signal,
    });

    return { path: target, query: searchText, ...result };
  });

  /**
   * Streaming search: matches and progress arrive while the walk is still
   * running, so a 10-second whole-disk scan shows results after 50 ms. Closing
   * the EventSource aborts the server-side walk.
   */
  app.get("/fs/search/stream", async (request, reply) => {
    const query = request.query as Query;
    const target = normalizePath(query.path);
    const searchText = text(query.q).trim();

    if (searchText.length < SEARCH_MIN_QUERY_LENGTH) {
      throw ApiError.badRequest("INVALID_QUERY", "请输入至少 1 个字符");
    }

    const stat = await statOrThrow(target);
    if (!stat.isDirectory()) {
      throw ApiError.badRequest(ERROR_CODES.notADirectory, "搜索起点必须是文件夹");
    }

    /*
     * Scope decides how wide the walk goes: the folder you are in, the whole
     * volume that folder lives on, or every drive. Wider scopes reuse the same
     * budget per root and stop as soon as the result limit is hit.
     */
    const scope = text(query.scope);
    const roots =
      scope === "disk"
        ? [path.parse(target).root]
        : scope === "all"
          ? await Promise.resolve()
              .then(async () => {
                const { listDrives } = await import("../lib/drives.js");
                return (await listDrives()).map((drive) => drive.path);
              })
              .catch(() => [path.parse(target).root])
          : [target];

    const limitValue = Number(query.limit ?? SEARCH_RESULT_LIMIT);
    const limit = Number.isFinite(limitValue) ? limitValue : SEARCH_RESULT_LIMIT;
    const budgetValue = Number(query.budgetMs ?? SEARCH_BUDGET_MS);
    const budgetMs = Number.isFinite(budgetValue)
      ? Math.min(Math.max(budgetValue, 500), 120_000)
      : SEARCH_BUDGET_MS;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...corsHeaders(request.headers.origin),
    });
    res.write(": search\n\n");

    const controller = new AbortController();
    let closed = false;
    const send = (event: string, data: unknown) => {
      if (closed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true;
      }
    };

    const abort = () => {
      controller.abort();
    };
    request.raw.on("close", abort);
    request.raw.on("error", abort);

    let lastProgress = 0;
    let scannedTotal = 0;

    try {
      let scanned = 0;
      let truncated = false;
      let timedOut = false;
      const collected: EntryDto[] = [];

      for (const root of roots) {
        if (controller.signal.aborted) break;
        const remaining = Math.max(limit - collected.length, 0);
        if (remaining === 0) break;

        const result = await searchDirectory(root, searchText, {
          showHidden: flag(query.showHidden),
          limit: remaining,
          budgetMs,
          signal: controller.signal,
          onMatches: (entries) => {
            collected.push(...entries);
            const payload: SearchMatchEvent = { entries };
            send("matches", payload);
          },
          onProgress: (count) => {
            const total = scannedTotal + count;
            const now = Date.now();
            if (now - lastProgress < 250) return;
            lastProgress = now;
            send("progress", { scanned: total });
          },
        });

        scanned += result.scanned;
        scannedTotal += result.scanned;
        truncated ||= result.truncated;
        timedOut ||= result.timedOut;
      }

      const result = { scanned, entries: collected, truncated, timedOut };

      const done: SearchDoneEvent = {
        path: target,
        query: searchText,
        scanned: result.scanned,
        total: result.entries.length,
        truncated: result.truncated,
        timedOut: result.timedOut,
      };
      send("done", done);
    } catch (error) {
      request.log.error(error);
      send("failed", { message: "搜索失败" });
    } finally {
      closed = true;
      try {
        res.end();
      } catch {
        // Client already gone.
      }
    }
  });

  app.get("/fs/download", async (request, reply) => {
    const query = request.query as Query;
    const target = resolveTarget(query.path);

    if (isArchivePath(target)) {
      const entry = await statArchiveEntry(target);
      if (entry.kind === "directory") {
        throw ApiError.badRequest("NOT_A_FILE", "不能下载文件夹");
      }
      const fileName = encodeURIComponent(entry.name).replace(/'/g, "%27");
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${fileName}`);
      reply.header("Content-Length", String(entry.size));
      reply.type("application/octet-stream");
      return reply.send(await createArchiveStream(target));
    }

    const stat = await statOrThrow(target);
    if (stat.isDirectory()) {
      throw ApiError.badRequest("NOT_A_FILE", "不能下载文件夹");
    }

    const fileName = encodeURIComponent(path.basename(target)).replace(/'/g, "%27");
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${fileName}`);
    reply.header("Content-Length", String(stat.size));
    reply.type("application/octet-stream");
    return reply.send(createDownloadStream(target));
  });

  app.post("/fs/mkdir", async (request) => {
    const body = (request.body ?? {}) as Body;
    assertNotArchive(body.path);
    const target = normalizePath(body.path);
    assertWritable(target);
    const name = validateEntryName(body.name);
    const created = await createFolder(target, name);
    return { path: created };
  });

  /** Creates an empty text file in the current folder. */
  app.post("/fs/new-file", async (request) => {
    const body = (request.body ?? {}) as Body;
    assertNotArchive(body.path);
    const target = normalizePath(body.path);
    assertWritable(target);
    const name = validateEntryName(body.name);
    const raw = typeof body.content === "string" ? body.content : "";
    // Seeded content is a convenience (an empty JSON object, a heading…), so it
    // stays small: this endpoint is not a write API.
    if (raw.length > 64 * 1024) {
      throw ApiError.badRequest("INVALID_BODY", "初始内容过大");
    }
    const created = await createFile(target, name, raw);
    return { path: created };
  });

  app.post("/fs/new-office-file", async (request) => {
    const body = (request.body ?? {}) as Body & { template?: unknown };
    assertNotArchive(body.path);
    const target = normalizePath(body.path);
    assertWritable(target);
    const name = validateEntryName(body.name);
    const template = String(body.template ?? "");
    if (template !== "docx" && template !== "xlsx" && template !== "pptx") {
      throw ApiError.badRequest(ERROR_CODES.invalidName, "不支持的文档模板");
    }
    if (!name.toLowerCase().endsWith(`.${template}`)) {
      throw ApiError.badRequest(ERROR_CODES.invalidName, `扩展名必须是 .${template}`);
    }
    // A real OOXML package: an empty file with a .docx name would not open.
    const created = await createFile(target, name, buildOfficeTemplate(template as OfficeTemplate));
    return { path: created };
  });

  app.post("/fs/terminal", async (request) => {
    const body = (request.body ?? {}) as Body;
    assertNotArchive(body.path);
    const target = normalizePath(body.path);
    const stat = await statOrThrow(target);
    const directory = stat.isDirectory() ? target : path.dirname(target);
    await openTerminal(directory);
    return { ok: true };
  });

  app.post("/fs/rename", async (request) => {
    const body = (request.body ?? {}) as Body;
    assertNotArchive(body.path);
    const target = normalizePath(body.path);
    assertWritable(target);
    const newName = validateEntryName(body.newName ?? body.name);
    const renamed = await renameEntry(target, newName);
    return { path: renamed };
  });

  app.post("/fs/batch-rename", async (request) => {
    const body = (request.body ?? {}) as Body & {
      items?: Array<{ path?: unknown; name?: unknown }>;
    };
    const raw = Array.isArray(body.items) ? body.items : [];
    if (raw.length === 0) {
      throw ApiError.badRequest(ERROR_CODES.invalidName, "没有要重命名的项目");
    }
    if (raw.length > 5000) {
      throw ApiError.badRequest(ERROR_CODES.invalidName, "一次最多重命名 5000 项");
    }

    // Validate the whole batch before touching the disk: a rejected item must
    // leave every other file as it was.
    const items = raw.map((item, index) => {
      assertNotArchive(item?.path);
      const target = normalizePath(item?.path);
      assertWritable(target);
      try {
        return { path: target, name: validateEntryName(item?.name) };
      } catch (error) {
        if (error instanceof ApiError) {
          throw ApiError.badRequest(error.code, `第 ${index + 1} 项：${error.message}`);
        }
        throw error;
      }
    });

    const renamed = await batchRenameEntries(items);
    return { renamed };
  });

  app.post("/fs/copy", async (request) => {
    const body = (request.body ?? {}) as Body;
    assertNoArchiveItems(body.sources);
    assertNoArchiveItems(body.sources);
    const sources = stringArray(body.sources);
    sources.forEach(assertWritable);
    const target = normalizePath(body.target);
    const created = await copyEntries(sources, target);
    return { paths: created };
  });

  app.post("/fs/move", async (request) => {
    const body = (request.body ?? {}) as Body;
    assertNoArchiveItems(body.sources);
    const sources = stringArray(body.sources);
    sources.forEach(assertWritable);
    const target = normalizePath(body.target);
    const moved = await moveEntries(sources, target);
    return { paths: moved };
  });

  app.post("/fs/delete", async (request) => {
    const body = (request.body ?? {}) as Body;
    assertNoArchiveItems(body.paths);
    const targets = stringArray(body.paths);
    targets.forEach(assertWritable);
    const permanent = flag(body.permanent);

    for (const target of targets) {
      assertSafeToDelete(target);
      await statOrThrow(target);
    }

    if (permanent) {
      for (const target of targets) {
        try {
          await fs.rm(target, { recursive: true, force: false });
        } catch (error) {
          throw fromFsError(error, target);
        }
      }
    } else {
      try {
        await trash(targets, { glob: false });
      } catch (error) {
        throw fromFsError(error);
      }
    }

    return { deleted: targets.length, permanent };
  });

  /**
   * Recycle bin: list, restore, purge. The client only ever sends the opaque
   * `$I` ids from the listing, so these endpoints cannot be pointed at
   * arbitrary files.
   */
  app.get("/recycle", async () => listRecycleBin());

  app.post("/recycle/restore", async (request) => {
    const body = (request.body ?? {}) as Body;
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((item): item is string => typeof item === "string")
      : [];
    if (ids.length === 0) {
      throw ApiError.badRequest("INVALID_BODY", "没有选择要还原的项目");
    }
    return restoreRecycleItems(ids);
  });

  app.post("/recycle/purge", async (request) => {
    const body = (request.body ?? {}) as Body;
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((item): item is string => typeof item === "string")
      : [];
    if (ids.length === 0) {
      throw ApiError.badRequest("INVALID_BODY", "没有选择要删除的项目");
    }
    return purgeRecycleItems(ids);
  });

  app.post("/recycle/empty", async () => emptyRecycleBin());

  /** Extract an entry (or the whole archive) into a real folder. */
  app.post("/archive/extract", async (request) => {
    const body = (request.body ?? {}) as Body;
    const target = resolveTarget(body.path);
    if (!isArchivePath(target)) {
      throw ApiError.badRequest("INVALID_ARCHIVE_PATH", "不是归档路径");
    }
    const destination = normalizePath(body.target);
    assertWritable(destination);
    const requested = typeof body.policy === "string" ? body.policy : "rename";
    const policy = requested === "overwrite" || requested === "skip" ? requested : "rename";

    return extractArchive(target, destination, policy);
  });

  /** Create an archive from real paths (zip by default). */
  app.post("/archive/create", async (request) => {
    const body = (request.body ?? {}) as Body;
    const sources = stringArray(body.sources);
    sources.forEach(assertWritable);
    const target = normalizePath(body.target);
    assertWritable(target);
    const name = validateEntryName(body.name);
    const destination = path.join(target, name);

    if (await pathExists(destination)) {
      throw ApiError.conflict(`“${name}” 已存在`);
    }

    const { createArchive } = await import("../lib/archives.js");
    await createArchive(sources, destination, name.toLowerCase().endsWith(".7z") ? "7z" : "zip");
    return { path: destination };
  });

  app.post("/fs/open", async (request) => {
    const body = (request.body ?? {}) as Body;
    const target = normalizePath(body.path);
    if (!(await pathExists(target))) {
      throw ApiError.notFound(`路径不存在：${target}`);
    }
    await openWithSystem(target);
    return { ok: true };
  });

  app.post("/fs/reveal", async (request) => {
    const body = (request.body ?? {}) as Body;
    const target = normalizePath(body.path);
    if (!(await pathExists(target))) {
      throw ApiError.notFound(`路径不存在：${target}`);
    }
    await revealInSystem(target);
    return { ok: true };
  });
};
