import { createReadStream, createWriteStream, fs } from "./native-fs.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  ConflictPolicy,
  TaskProgressDto,
  TransferKind,
} from "@oriel/shared";
import { promises as plainFs, createWriteStream as plainWriteStream } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { Readable } from "node:stream";
import { measureDirectory } from "./file-info.js";

/**
 * Background copy/move queue.
 *
 * Large transfers used to block the request until the last byte landed, which
 * made the UI look frozen and gave no way to cancel. Transfers now run as tasks
 * and stream progress over the event channel.
 *
 * Progress is reported in bytes as well as entries, cancellation is checked per
 * 1 MiB chunk, and an overwrite swaps the new tree in through a staging
 * directory so a failed copy can never destroy the existing entry.
 */

export type { ConflictPolicy, TransferKind };

export type TaskProgress = TaskProgressDto;

const emitter = new EventEmitter();
emitter.setMaxListeners(80);

const tasks = new Map<string, TaskProgress>();
const cancelled = new Set<string>();
const paused = new Set<string>();
/** Original request, kept so a failed task can be retried. */
const taskRequests = new Map<
  string,
  { kind: TransferKind; sources: string[]; target: string; policy: ConflictPolicy }
>();

/** Terminal tasks are kept for reconnects, then dropped. */
const TASK_TTL_MS = 10 * 60_000;
const MAX_TASKS = 200;
/** Repaint ceiling for progress events; a 50 GB copy must not flood the SSE. */
const PROGRESS_INTERVAL_MS = 200;

export function onTaskProgress(
  listener: (task: TaskProgress) => void,
): () => void {
  emitter.on("task", listener);
  return () => emitter.off("task", listener);
}

function isTerminal(task: TaskProgress): boolean {
  return (
    task.status === "done" ||
    task.status === "failed" ||
    task.status === "cancelled"
  );
}

function sweep(): void {
  const now = Date.now();
  for (const [id, task] of tasks) {
    if (!isTerminal(task)) continue;
    const finishedAt = (task as TaskProgress & { finishedAt?: number }).finishedAt;
    if (tasks.size <= MAX_TASKS && finishedAt && now - finishedAt < TASK_TTL_MS) {
      continue;
    }
    if (isTerminal(task)) tasks.delete(id);
  }
}

export function getTask(id: string): TaskProgress | null {
  return tasks.get(id) ?? null;
}

export function pauseTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || isTerminal(task)) return false;
  paused.add(id);
  task.status = "paused";
  publish(task);
  return true;
}

export function resumeTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task || isTerminal(task)) return false;
  paused.delete(id);
  task.status = "running";
  publish(task);
  return true;
}

/** Re-runs a finished/failed task with the same request. */
export function retryTask(id: string): TaskProgress | null {
  const request = taskRequests.get(id);
  if (!request) return null;
  return createTransfer(request.kind, request.sources, request.target, request.policy);
}

export function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;
  if (isTerminal(task)) return false;
  cancelled.add(id);
  return true;
}

function publish(task: TaskProgress): void {
  tasks.set(task.id, task);
  emitter.emit("task", { ...task, created: [...task.created] });
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function uniquePath(directory: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(directory, `${stem} (${index})${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  return path.join(directory, `${stem} (${Date.now()})${ext}`);
}

async function resolveDestination(
  source: string,
  target: string,
  policy: ConflictPolicy,
): Promise<string | null> {
  const destination = path.join(target, path.basename(source));
  if (!(await exists(destination))) return destination;

  switch (policy) {
    case "overwrite":
      // The caller replaces it through a staging directory.
      return destination;
    case "skip":
      return null;
    default:
      // "rename" and "keep-both" both preserve the incoming item under a new name.
      return uniquePath(target, path.basename(source));
  }
}

interface Tracker {
  add(bytes: number): void;
  check(): void;
  isPaused(): boolean;
  /** Resolves once the task is no longer paused (throws when cancelled). */
  wait(): Promise<void>;
}

function createTracker(task: TaskProgress, id: string): Tracker {
  let lastPublished = 0;

  return {
    add(bytes: number) {
      task.bytesDone = (task.bytesDone ?? 0) + bytes;
      const now = Date.now();
      if (now - lastPublished >= PROGRESS_INTERVAL_MS) {
        lastPublished = now;
        publish(task);
      }
    },
    check() {
      if (cancelled.has(id)) throw new CancelledError();
    },
    isPaused() {
      return paused.has(id);
    },
    async wait() {
      while (paused.has(id)) {
        if (cancelled.has(id)) throw new CancelledError();
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (cancelled.has(id)) throw new CancelledError();
    },
  };
}

function copyFile(
  source: string,
  destination: string,
  tracker: Tracker,
  stat: { atime: Date; mtime: Date },
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const read = createReadStream(source);
    const write = createWriteStream(destination, { flags: "wx" });
    let settled = false;
    /** True while we hold the read stream for a user pause. */
    let pausedByUser = false;
    let waitingForDrain = false;
    let pauseTimer: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (pauseTimer) {
        clearInterval(pauseTimer);
        pauseTimer = null;
      }
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      read.destroy();
      write.destroy();
      reject(error);
    };

    /** Pausing the stream is not enough: `pipe()` resumes it on drain. */
    const applyUserPause = () => {
      if (pausedByUser || !tracker.isPaused()) return;
      pausedByUser = true;
      read.pause();
      pauseTimer = setInterval(() => {
        if (settled) {
          cleanup();
          return;
        }
        if (tracker.isPaused()) return;
        cleanup();
        pausedByUser = false;
        if (!waitingForDrain) read.resume();
      }, 120);
    };

    read.on("error", fail);
    write.on("error", fail);

    read.on("data", (chunk: string | Buffer) => {
      if (settled) return;
      const length = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      tracker.add(length);
      try {
        tracker.check();
      } catch (error) {
        fail(error);
        return;
      }

      const writable = write.write(chunk);
      if (!writable) {
        waitingForDrain = true;
        read.pause();
        write.once("drain", () => {
          waitingForDrain = false;
          if (!pausedByUser) read.resume();
        });
      }

      applyUserPause();
    });

    read.on("end", () => {
      if (!settled) write.end();
    });

    write.on("finish", () => {
      if (settled) return;
      settled = true;
      cleanup();
      void fs
        .utimes(destination, stat.atime, stat.mtime)
        .catch(() => undefined)
        .then(() => resolve());
    });
  });
}

/**
 * Recursive copy with byte progress. Symlinks are recreated as links (matching
 * `fs.cp`'s default) and fall back to copying the target when the platform
 * refuses to create one.
 */
async function copyTree(
  source: string,
  destination: string,
  tracker: Tracker,
): Promise<void> {
  tracker.check();

  const lstat = await fs.lstat(source);

  if (lstat.isSymbolicLink()) {
    const link = await fs.readlink(source);
    try {
      await fs.symlink(link, destination);
    } catch {
      const stat = await fs.stat(source).catch(() => null);
      if (stat?.isFile()) {
        await copyFile(source, destination, tracker, lstat);
      } else if (stat?.isDirectory()) {
        await fs.mkdir(destination, { recursive: true });
      }
    }
    return;
  }

  if (lstat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    const entries = await fs.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await tracker.wait();
      tracker.check();
      await copyTree(
        path.join(source, entry.name),
        path.join(destination, entry.name),
        tracker,
      );
    }
    await fs.utimes(destination, lstat.atime, lstat.mtime).catch(() => undefined);
    return;
  }

  await copyFile(source, destination, tracker, lstat);
}

async function moveEntry(
  source: string,
  destination: string,
  tracker: Tracker,
  onCrossVolume: () => Promise<void>,
): Promise<void> {
  tracker.check();
  try {
    await fs.rename(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }

  // Cross-volume move: copy the tree, then drop the source.
  await onCrossVolume();
  await copyTree(source, destination, tracker);
  await fs.rm(source, { recursive: true, force: true });
}

/** Looks up the size before a copy so the progress bar has a denominator. */
async function estimateBytes(sources: string[]): Promise<number> {
  let total = 0;
  for (const source of sources) {
    try {
      const stat = await fs.lstat(source);
      if (stat.isDirectory()) {
        total += (await measureDirectory(source)).size;
      } else {
        total += stat.size;
      }
    } catch {
      // Vanished sources are reported by the transfer itself.
    }
  }
  return total;
}

async function runTransfer(
  task: TaskProgress,
  sources: string[],
  target: string,
  policy: ConflictPolicy,
): Promise<void> {
  taskRequests.set(task.id, {
    kind: task.kind === "move" ? "move" : "copy",
    sources,
    target,
    policy,
  });
  task.status = "running";
  publish(task);

  // A same-volume move is a rename, so only copies pay for the size scan.
  if (task.kind === "copy") {
    task.bytesTotal = await estimateBytes(sources);
    publish(task);
  }
  task.bytesDone = 0;
  publish(task);

  const tracker = createTracker(task, task.id);
  /** Destination paths this task created, used to clean up after a failure. */
  const created: string[] = [];

  try {
    for (const source of sources) {
      tracker.check();

      task.current = path.basename(source);
      publish(task);

      const destination = await resolveDestination(source, target, policy);
      if (!destination) {
        task.done += 1;
        publish(task);
        continue;
      }

      const replacing = policy === "overwrite" && (await exists(destination));
      const staged = replacing ? `${destination}.macexplorer-new` : destination;
      const backup = `${destination}.macexplorer-old`;

      if (replacing) await fs.rm(staged, { recursive: true, force: true }).catch(() => undefined);

      try {
        if (task.kind === "copy") await copyTree(source, staged, tracker);
        else {
          await moveEntry(source, staged, tracker, async () => {
            const stat = await fs.lstat(source);
            task.bytesTotal =
              (task.bytesTotal ?? 0) +
              (stat.isDirectory() ? (await measureDirectory(source)).size : stat.size);
            publish(task);
          });
        }

        if (replacing) {
          if (await exists(backup)) {
            await fs.rm(backup, { recursive: true, force: true });
          }
          await fs.rename(destination, backup);
          await fs.rename(staged, destination);
          await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
        }
      } catch (error) {
        await fs.rm(staged, { recursive: true, force: true }).catch(() => undefined);
        if (replacing && (await exists(backup)) && !(await exists(destination))) {
          await fs.rename(backup, destination).catch(() => undefined);
        }
        throw error;
      }

      created.push(destination);
      task.created.push(destination);
      task.done += 1;
      publish(task);
    }

    task.status = "done";
  } catch (error) {
    const wasCancelled = error instanceof CancelledError || cancelled.has(task.id);
    task.status = wasCancelled ? "cancelled" : "failed";

    if (!wasCancelled) {
      task.error = error instanceof Error ? error.message : String(error);
      // A half-written tree is worse than no tree: drop what this task created.
      for (const item of created) {
        await fs.rm(item, { recursive: true, force: true }).catch(() => undefined);
      }
      task.created = [];
    }
  } finally {
    task.current = null;
    (task as TaskProgress & { finishedAt?: number }).finishedAt = Date.now();
    cancelled.delete(task.id);
    paused.delete(task.id);
    publish(task);
    sweep();
  }
}

export function createTransfer(
  kind: TransferKind,
  sources: string[],
  target: string,
  policy: ConflictPolicy,
): TaskProgress {
  sweep();

  const task: TaskProgress = {
    id: randomUUID(),
    kind,
    status: "queued",
    total: sources.length,
    done: 0,
    current: null,
    bytesDone: 0,
    bytesTotal: 0,
    created: [],
  };

  publish(task);
  void runTransfer(task, sources, target, policy);
  return task;
}

/** Which sources would collide with something already in `target`. */
export async function findConflicts(
  sources: string[],
  target: string,
): Promise<Array<{ source: string; destination: string }>> {
  const conflicts: Array<{ source: string; destination: string }> = [];

  for (const source of sources) {
    const destination = path.join(target, path.basename(source));
    if (source.toLowerCase() === destination.toLowerCase()) continue;
    if (await exists(destination)) conflicts.push({ source, destination });
  }

  return conflicts;
}

const UPDATE_DIRECTORY = path.join(os.tmpdir(), "oriel-updates");

/**
 * Downloads a release asset into the temp folder with byte-level progress.
 * Reuses the task plumbing so the operations center shows it like any other
 * job (cancel included).
 */
export function createDownload(url: string, name: string): TaskProgress {
  const safeName = name.replace(/[\\/:*?"<>|]/g, "_") || "update-download";
  const destination = path.join(UPDATE_DIRECTORY, safeName);

  const task: TaskProgress = {
    id: randomUUID(),
    kind: "download",
    status: "queued",
    total: 1,
    done: 0,
    current: safeName,
    bytesDone: 0,
    bytesTotal: 0,
    created: [],
  };

  publish(task);

  void (async () => {
    const tracker = createTracker(task, task.id);
    try {
      task.status = "running";
      publish(task);

      await plainFs.mkdir(UPDATE_DIRECTORY, { recursive: true });

      // `fetch` (undici) resets the connection on some networks where the
      // plain https client works, so the download uses node:https directly and
      // follows redirects itself (GitHub redirects to its CDN).
      const openStream = (
        target: string,
        redirects = 0,
      ): Promise<{ stream: Readable; total: number }> =>
        new Promise((resolve, reject) => {
          const client = target.startsWith("https:") ? https : http;
          const request = client.get(
            target,
            // Node's default happy-eyeballs picks the working address family;
            // pinning one breaks either IPv6-only mirrors or IPv4-only hosts.
            { headers: { "User-Agent": "oriel-updater" } },
            (response) => {
              const status = response.statusCode ?? 0;
              const location = response.headers.location;
              if (status >= 300 && status < 400 && location && redirects < 5) {
                response.destroy();
                resolve(
                  openStream(new URL(location, target).toString(), redirects + 1),
                );
                return;
              }
              if (status !== 200) {
                response.destroy();
                reject(new Error(`下载失败：HTTP ${status}`));
                return;
              }
              resolve({
                stream: response,
                total: Number(response.headers["content-length"] ?? 0),
              });
            },
          );
          request.on("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ECONNREFUSED") {
              reject(
                new Error(
                  "下载地址无法连接（可能被网络或 DNS 屏蔽）。可配置 ORIEL_UPDATE_CDN 使用镜像。",
                ),
              );
              return;
            }
            reject(error);
          });
          request.setTimeout(30_000, () => request.destroy(new Error("连接超时")));
        });

      const { stream, total } = await openStream(url);
      if (total > 0) {
        task.bytesTotal = total;
        publish(task);
      }

      stream.on("data", (chunk: Buffer) => {
        tracker.add(chunk.length);
        tracker.check();
      });

      await new Promise<void>((resolve, reject) => {
        const file = plainWriteStream(destination, { flags: "w" });
        let settled = false;
        const finish = (error?: unknown) => {
          if (settled) return;
          settled = true;
          if (error) {
            stream.destroy();
            file.destroy();
            reject(error);
          } else {
            resolve();
          }
        };
        stream.on("error", finish);
        file.on("error", finish);
        file.on("finish", () => finish());
        stream.pipe(file);
      });

      task.created = [destination];
      task.done = 1;
      task.status = "done";
    } catch (error) {
      const wasCancelled = error instanceof CancelledError || cancelled.has(task.id);
      task.status = wasCancelled ? "cancelled" : "failed";
      if (!wasCancelled) {
        task.error = error instanceof Error ? error.message : String(error);
      }
      await plainFs.rm(destination, { force: true }).catch(() => undefined);
    } finally {
      task.current = null;
      (task as TaskProgress & { finishedAt?: number }).finishedAt = Date.now();
      cancelled.delete(task.id);
      paused.delete(task.id);
      publish(task);
      sweep();
    }
  })();

  return task;
}
