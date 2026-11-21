import path from "node:path";
import type { RecycleItemDto } from "@oriel/shared";
import { ApiError, fromFsError } from "../errors.js";
import { listDrives } from "./drives.js";
import { fs } from "./native-fs.js";

/**
 * Windows recycle bin access without COM or PowerShell.
 *
 * Every volume keeps `$Recycle.Bin\<user SID>\` with paired files: `$I…` holds
 * metadata (original size, deletion time, original path) and `$R…` the data.
 * Reading those sidecars directly is a couple of file reads instead of a
 * PowerShell process, and it is what makes restore/purge a plain `rename`/`rm`.
 */

const RECYCLE_DIRECTORY = "$Recycle.Bin";
/** Difference between the FILETIME epoch (1601) and the Unix epoch, in 100 ns ticks. */
const FILETIME_EPOCH_OFFSET = 116_444_736_000_000_000n;

interface RecycleItem extends RecycleItemDto {
  /** `$I…` metadata file. */
  metaPath: string;
  /** `$R…` payload. */
  dataPath: string;
}

function parseSidecar(buffer: Buffer): {
  size: number;
  deletedAt: number;
  originalPath: string;
} | null {
  if (buffer.length < 28) return null;

  const version = Number(buffer.readBigUInt64LE(0));
  const size = Number(buffer.readBigInt64LE(8));
  const filetime = buffer.readBigInt64LE(16);
  const deletedAt =
    filetime > FILETIME_EPOCH_OFFSET
      ? Number((filetime - FILETIME_EPOCH_OFFSET) / 10_000n)
      : 0;

  // Version 2 (Windows 10+) stores the path length in UTF-16 *characters*;
  // older sidecars have a fixed-size field that simply runs to EOF.
  let nameBytes: number;
  let nameOffset: number;
  if (version >= 2) {
    nameOffset = 28;
    nameBytes = buffer.readUInt32LE(24) * 2;
  } else {
    nameOffset = 24;
    nameBytes = buffer.length - nameOffset;
  }

  if (nameBytes <= 0 || nameOffset + nameBytes > buffer.length) {
    nameOffset = version >= 2 ? 28 : 24;
    nameBytes = buffer.length - nameOffset;
  }

  const originalPath = buffer
    .subarray(nameOffset, nameOffset + nameBytes)
    .toString("utf16le")
    .replace(/\0+$/, "");

  if (!originalPath.trim()) return null;
  return { size, deletedAt, originalPath };
}

async function binRoots(): Promise<string[]> {
  const drives = await listDrives().catch(() => []);
  const roots = drives
    .filter((drive) => drive.kind !== "network")
    .map((drive) => path.join(drive.path, RECYCLE_DIRECTORY));

  // Network drives have no local bin; fall back to the current drive anyway.
  if (roots.length === 0) {
    roots.push(path.join(path.parse(process.cwd()).root, RECYCLE_DIRECTORY));
  }
  return roots;
}

/** Reads one `$I` sidecar into a recycle item, or null when it is malformed. */
async function readItem(
  metaPath: string,
  drive: string,
): Promise<RecycleItem | null> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(metaPath);
  } catch {
    return null;
  }

  const meta = parseSidecar(buffer);
  if (!meta) return null;

  const base = path.basename(metaPath);
  const dataPath = path.join(path.dirname(metaPath), `$R${base.slice(2)}`);

  let kind: "file" | "directory" = "file";
  let size = meta.size;
  try {
    const stat = await fs.lstat(dataPath);
    kind = stat.isDirectory() ? "directory" : "file";
    size = stat.isDirectory() ? meta.size : stat.size;
  } catch {
    // Payload already gone: the sidecar is stale, skip it.
    return null;
  }

  return {
    id: metaPath,
    metaPath,
    dataPath,
    name: path.basename(meta.originalPath) || meta.originalPath,
    originalPath: meta.originalPath,
    size,
    deletedAt: meta.deletedAt,
    kind,
    drive,
  };
}

async function listRoot(root: string, drive: string): Promise<RecycleItem[]> {
  let sids: string[];
  try {
    sids = await fs.readdir(root);
  } catch {
    return [];
  }

  const items: RecycleItem[] = [];
  for (const sid of sids) {
    if (!/^S-1-5-/.test(sid)) continue;

    let names: string[];
    try {
      names = await fs.readdir(path.join(root, sid));
    } catch {
      // Another user's bin: reading it needs elevation.
      continue;
    }

    const metas = names.filter((name) => name.startsWith("$I"));
    const found = await Promise.all(
      metas.map((name) => readItem(path.join(root, sid, name), drive)),
    );
    for (const item of found) if (item) items.push(item);
  }

  return items;
}

async function listItems(): Promise<{
  items: RecycleItem[];
  skippedDrives: string[];
}> {
  const roots = await binRoots();
  const skippedDrives: string[] = [];
  const items: RecycleItem[] = [];

  for (const root of roots) {
    const drive = path.parse(root).root;
    try {
      await fs.access(root);
    } catch {
      skippedDrives.push(drive);
      continue;
    }
    items.push(...(await listRoot(root, drive)));
  }

  items.sort((a, b) => b.deletedAt - a.deletedAt);
  return { items, skippedDrives };
}

export async function listRecycleBin(): Promise<{
  items: RecycleItemDto[];
  total: number;
  skippedDrives: string[];
}> {
  const { items, skippedDrives } = await listItems();

  return {
    items: items.map(({ metaPath: _meta, dataPath: _data, ...rest }) => rest),
    total: items.reduce((sum, item) => sum + item.size, 0),
    skippedDrives,
  };
}

/**
 * Turns a client-supplied id back into a pair of paths, but only if it really
 * points at a `$I` file inside a recycle bin whose `$R` payload exists. Without
 * this the purge endpoint would be a "delete any file" API.
 */
async function resolve(id: string): Promise<RecycleItem> {
  if (typeof id !== "string" || !path.isAbsolute(id)) {
    throw ApiError.badRequest("INVALID_RECYCLE_ID", "无效的回收站项目");
  }

  const metaPath = path.resolve(id);
  const parent = path.basename(path.dirname(metaPath)).toUpperCase();
  const grandParent = path.basename(path.dirname(path.dirname(metaPath)));
  const base = path.basename(metaPath);

  if (
    !/^\$I/.test(base) ||
    !/^S-1-5-/.test(parent) ||
    grandParent.toLowerCase() !== RECYCLE_DIRECTORY.toLowerCase()
  ) {
    throw ApiError.badRequest("INVALID_RECYCLE_ID", "无效的回收站项目");
  }

  const item = await readItem(metaPath, path.parse(metaPath).root);
  if (!item) throw ApiError.notFound("该项目已不在回收站中");
  return item;
}

export async function restoreRecycleItems(ids: string[]): Promise<{
  restored: string[];
  skipped: Array<{ id: string; reason: string }>;
}> {
  const restored: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of ids.slice(0, 500)) {
    let item: RecycleItem;
    try {
      item = await resolve(id);
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : "无效项目" });
      continue;
    }

    try {
      const parent = path.dirname(item.originalPath);
      await fs.mkdir(parent, { recursive: true });
      if (await fs.access(item.originalPath).then(() => true).catch(() => false)) {
        skipped.push({ id, reason: `“${item.name}” 的原位置已有同名项目` });
        continue;
      }
      await fs.rename(item.dataPath, item.originalPath);
      await fs.rm(item.metaPath, { force: true });
      restored.push(item.originalPath);
    } catch (error) {
      skipped.push({ id, reason: fromFsError(error, item.originalPath).message });
    }
  }

  return { restored, skipped };
}

export async function purgeRecycleItems(ids: string[]): Promise<{
  purged: number;
  skipped: Array<{ id: string; reason: string }>;
}> {
  let purged = 0;
  const skipped: Array<{ id: string; reason: string }> = [];

  for (const id of ids.slice(0, 500)) {
    try {
      const item = await resolve(id);
      await fs.rm(item.dataPath, { recursive: true, force: true });
      await fs.rm(item.metaPath, { force: true });
      purged += 1;
    } catch (error) {
      skipped.push({ id, reason: error instanceof Error ? error.message : "无效项目" });
    }
  }

  return { purged, skipped };
}

export async function emptyRecycleBin(): Promise<{
  purged: number;
  skipped: number;
}> {
  const { items } = await listItems();
  let purged = 0;
  let skipped = 0;

  for (const item of items) {
    try {
      await fs.rm(item.dataPath, { recursive: true, force: true });
      await fs.rm(item.metaPath, { force: true });
      purged += 1;
    } catch {
      skipped += 1;
    }
  }

  return { purged, skipped };
}
