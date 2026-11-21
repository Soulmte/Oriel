import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { promisify } from "node:util";
import type { EntryDto } from "@oriel/shared";
import { ApiError, fromFsError } from "../errors.js";
import { buildArchivePath, parseArchivePath } from "./archive-path.js";
import { fs } from "./native-fs.js";

/**
 * Archive support through the 7-Zip command line.
 *
 * `7z l -slt -ba` prints one `Key = Value` block per entry, which is stable
 * across formats (zip/7z/rar/tar/gz/iso…), so one parser covers everything.
 * Listing is cached per (archive, mtime, size); the archive itself is treated as
 * read-only — writes are refused by the routes.
 */

const execFileAsync = promisify(execFile);

/** Hard limits: an archive must not be able to blow up the process. */
const MAX_ENTRIES = 50_000;
const MAX_LIST_BYTES = 64 * 1024 * 1024;
const LIST_CACHE_ENTRIES = 20;
const LIST_CACHE_TTL_MS = 60_000;
const EXTRACT_TIMEOUT_MS = 10 * 60_000;

const SEVEN_ZIP_CANDIDATES = [
  "C:\\Program Files\\7-Zip\\7z.exe",
  "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  "D:\\7z\\7-Zip\\7z.exe",
];

let sevenZipPath: string | null | undefined;
let sevenZipProbe: Promise<string | null> | null = null;

async function readRegistryPath(): Promise<string | null> {
  const keys = [
    ["HKLM\\SOFTWARE\\7-Zip", "Path"],
    ["HKLM\\SOFTWARE\\WOW6432Node\\7-Zip", "Path"],
    ["HKCU\\SOFTWARE\\7-Zip", "Path"],
  ];
  for (const [key, name] of keys) {
    try {
      const { stdout } = await execFileAsync(
        "reg.exe",
        ["query", key, "/v", name],
        { timeout: 4000, windowsHide: true, encoding: "utf8" },
      );
      const match = /Path\s+REG_SZ\s+(.+)/i.exec(stdout);
      const dir = match?.[1]?.trim();
      if (dir) return path.join(dir, "7z.exe");
    } catch {
      // Key missing: try the next candidate.
    }
  }
  return null;
}

/** Locates 7z.exe once; the result (including "not found") is cached. */
export async function locate7z(): Promise<string | null> {
  if (sevenZipPath !== undefined) return sevenZipPath;
  if (sevenZipProbe) return sevenZipProbe;

  sevenZipProbe = (async () => {
    const candidates: string[] = [];
    const fromRegistry = await readRegistryPath().catch(() => null);
    if (fromRegistry) candidates.push(fromRegistry);

    const fromPath = (process.env.PATH ?? "")
      .split(";")
      .filter(Boolean)
      .map((dir) => path.join(dir, "7z.exe"));
    candidates.push(...fromPath, ...SEVEN_ZIP_CANDIDATES);

    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        sevenZipPath = candidate;
        return candidate;
      } catch {
        // Keep looking.
      }
    }

    sevenZipPath = null;
    return null;
  })().finally(() => {
    sevenZipProbe = null;
  });

  return sevenZipProbe;
}

async function requireSevenZip(): Promise<string> {
  const tool = await locate7z();
  if (!tool) {
    throw ApiError.badRequest(
      "ARCHIVE_TOOL_MISSING",
      "未找到 7-Zip，请安装 7-Zip 或把 7z.exe 放到 PATH 中",
    );
  }
  return tool;
}

interface ArchiveEntry {
  inner: string;
  name: string;
  directory: boolean;
  size: number;
  mtimeMs: number;
}

function parseTime(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!match) return 0;
  const [, y, mo, d, h, mi, s] = match;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  ).getTime();
}

/** Parses `7z l -slt -ba` output into flat entries. */
function parseListing(output: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let current: Record<string, string> = {};

  const flush = () => {
    const raw = current.Path;
    if (raw) {
      const inner = raw.replace(/\//g, "\\").replace(/\\+$/, "");
      if (inner) {
        entries.push({
          inner,
          name: inner.split("\\").pop() ?? inner,
          directory: current.Folder === "+",
          size: Number(current.Size ?? 0) || 0,
          mtimeMs: parseTime(current.Modified ?? ""),
        });
      }
    }
    current = {};
  };

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const index = line.indexOf(" = ");
    if (index <= 0) continue;
    current[line.slice(0, index)] = line.slice(index + 3);
  }
  flush();

  return entries;
}

const listCache = new Map<
  string,
  { at: number; entries: ArchiveEntry[] }
>();

function rememberListing(key: string, entries: ArchiveEntry[]): void {
  listCache.delete(key);
  if (listCache.size >= LIST_CACHE_ENTRIES) {
    const oldest = listCache.keys().next().value;
    if (oldest) listCache.delete(oldest);
  }
  listCache.set(key, { at: Date.now(), entries });
}

async function entriesOf(archivePath: string): Promise<ArchiveEntry[]> {
  const stat = await fs.stat(archivePath).catch(() => null);
  if (!stat || stat.isDirectory()) {
    throw ApiError.notFound(`归档不存在：${archivePath}`);
  }

  const key = `${archivePath}|${Math.round(stat.mtimeMs)}|${stat.size}`;
  const cached = listCache.get(key);
  if (cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) return cached.entries;

  const tool = await requireSevenZip();
  let stdout: string;
  try {
    const result = await execFileAsync(
      tool,
      ["l", "-slt", "-ba", "-sccUTF-8", archivePath],
      {
        timeout: 60_000,
        maxBuffer: MAX_LIST_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    stdout = result.stdout;
  } catch (error) {
    throw fromFsError(error, archivePath);
  }

  const entries = parseListing(stdout).slice(0, MAX_ENTRIES);
  rememberListing(key, entries);
  return entries;
}

/** Direct children of `inner` as normal EntryDto rows. */
export async function listArchive(target: string): Promise<{
  path: string;
  parent: string | null;
  entries: EntryDto[];
}> {
  const { archive, inner } = parseArchivePath(target);
  const all = await entriesOf(archive);
  const prefix = inner ? `${inner}\\` : "";

  const directories = new Set<string>();
  const children = new Map<string, ArchiveEntry>();

  for (const entry of all) {
    if (prefix && !entry.inner.startsWith(prefix)) continue;
    const rest = prefix ? entry.inner.slice(prefix.length) : entry.inner;
    if (!rest) continue;

    const separator = rest.indexOf("\\");
    if (separator === -1) {
      children.set(rest, entry);
      if (entry.directory) directories.add(rest);
    } else {
      // A nested file implies its parent directory exists.
      directories.add(rest.slice(0, separator));
    }
  }

  const entries: EntryDto[] = [];
  for (const [name, entry] of children) {
    const directory = directories.has(name) || entry.directory;
    entries.push({
      name,
      path: buildArchivePath(archive, prefix ? `${prefix}${name}` : name),
      kind: directory ? "directory" : "file",
      size: directory ? 0 : entry.size,
      mtimeMs: entry.mtimeMs,
      birthtimeMs: entry.mtimeMs,
      ext: directory ? "" : path.extname(name).slice(1).toLowerCase(),
      hidden: name.startsWith("."),
      readonly: false,
      isLink: false,
    });
  }

  for (const name of directories) {
    if (children.has(name)) continue;
    const full = prefix ? `${prefix}${name}` : name;
    entries.push({
      name,
      path: buildArchivePath(archive, full),
      kind: "directory",
      size: 0,
      mtimeMs: 0,
      birthtimeMs: 0,
      ext: "",
      hidden: name.startsWith("."),
      readonly: false,
      isLink: false,
    });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return {
    path: target,
    parent: inner ? buildArchivePath(archive, inner.split("\\").slice(0, -1).join("\\")) : path.dirname(archive),
    entries,
  };
}

export async function statArchiveEntry(target: string): Promise<EntryDto> {
  const { archive, inner } = parseArchivePath(target);
  if (!inner) {
    const stat = await fs.stat(archive);
    return {
      name: path.basename(archive),
      path: target,
      kind: "directory",
      size: 0,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs || stat.mtimeMs,
      ext: "",
      hidden: false,
      readonly: false,
      isLink: false,
    };
  }

  const all = await entriesOf(archive);
  const entry = all.find((item) => item.inner === inner);
  if (!entry) throw ApiError.notFound(`归档中没有该条目：${inner}`);

  return {
    name: entry.name,
    path: target,
    kind: entry.directory ? "directory" : "file",
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    birthtimeMs: entry.mtimeMs,
    ext: entry.directory ? "" : path.extname(entry.name).slice(1).toLowerCase(),
    hidden: false,
    readonly: false,
    isLink: false,
  };
}

/** Streams one entry out of the archive (stdout of `7z x -so`). */
export async function createArchiveStream(target: string): Promise<Readable> {
  const { archive, inner } = parseArchivePath(target);
  if (!inner) throw ApiError.badRequest("NOT_A_FILE", "这是归档根目录");

  const tool = await requireSevenZip();
  const child = spawn(tool, ["x", "-so", archive, inner], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.on("error", () => undefined);
  return child.stdout;
}

/** Reads one entry into memory, up to `limit` bytes. */
export async function readArchiveEntry(
  target: string,
  limit: number,
): Promise<{ buffer: Buffer; size: number }> {
  const { archive, inner } = parseArchivePath(target);
  if (!inner) throw ApiError.badRequest("NOT_A_FILE", "这是归档根目录");

  const all = await entriesOf(archive);
  const entry = all.find((item) => item.inner === inner);
  if (!entry) throw ApiError.notFound(`归档中没有该条目：${inner}`);
  if (entry.directory) throw ApiError.badRequest("NOT_A_FILE", "这是文件夹");

  const tool = await requireSevenZip();
  const stdout = await execFileAsync(
    tool,
    ["x", "-so", archive, inner],
    {
      timeout: 60_000,
      maxBuffer: Math.max(limit, 1) + 1024,
      windowsHide: true,
      encoding: "buffer",
    },
  )
    .then((result) => result.stdout as unknown as Buffer)
    .catch((error) => {
      throw fromFsError(error, target);
    });

  return { buffer: stdout.subarray(0, limit), size: entry.size };
}

/** Extracts `inner` (or the whole archive) into `targetDirectory`. */
export async function extractArchive(
  target: string,
  destination: string,
  policy: "overwrite" | "skip" | "rename",
): Promise<{ extracted: string[] }> {
  const { archive, inner } = parseArchivePath(target);
  const tool = await requireSevenZip();

  await fs.mkdir(destination, { recursive: true });

  const args = ["x", archive, `-o${destination}`, "-y", "-sccUTF-8"];
  if (inner) args.push(inner);
  if (policy === "overwrite") args.push("-aoa");
  else args.push("-aos");

  try {
    await execFileAsync(tool, args, {
      timeout: EXTRACT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: "utf8",
    });
  } catch (error) {
    throw fromFsError(error, destination);
  }

  return { extracted: [destination] };
}

/** Creates an archive from real paths (`7z a`). */
export async function createArchive(
  sources: string[],
  destination: string,
  format: "zip" | "7z",
): Promise<void> {
  if (sources.length === 0) {
    throw ApiError.badRequest("INVALID_BODY", "没有要压缩的项目");
  }

  const tool = await requireSevenZip();
  // 7z stores the path relative to the working directory, so run from the
  // common parent and pass names only.
  const parent = path.dirname(sources[0]);
  const relative = sources.map((source) => path.relative(parent, source));

  try {
    await execFileAsync(
      tool,
      ["a", `-t${format}`, "-y", "-sccUTF-8", destination, ...relative],
      {
        cwd: parent,
        timeout: EXTRACT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
    );
  } catch (error) {
    throw fromFsError(error, destination);
  }
}
