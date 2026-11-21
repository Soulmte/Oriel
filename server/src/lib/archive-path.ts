import path from "node:path";
import { ApiError } from "../errors.js";

/**
 * Virtual paths for archive contents.
 *
 * `archive://D:\a.zip|docs/readme.txt` — the `|` separator cannot appear in a
 * Windows path, so the archive itself and the entry inside it stay unambiguous
 * without escaping (and the whole thing survives a URL query round-trip).
 */

export const ARCHIVE_SCHEME = "archive://";
const SEPARATOR = "|";

export interface ArchiveLocation {
  /** Absolute path of the archive file. */
  archive: string;
  /** Entry inside the archive, backslash separated, "" for the root. */
  inner: string;
}

export function isArchivePath(target: string): boolean {
  return typeof target === "string" && target.startsWith(ARCHIVE_SCHEME);
}

export function parseArchivePath(target: string): ArchiveLocation {
  if (!isArchivePath(target)) {
    throw ApiError.badRequest("INVALID_ARCHIVE_PATH", "不是归档路径");
  }

  const body = target.slice(ARCHIVE_SCHEME.length);
  const index = body.indexOf(SEPARATOR);
  const archive = index === -1 ? body : body.slice(0, index);
  const rawInner = index === -1 ? "" : body.slice(index + 1);

  if (!archive || !path.isAbsolute(archive)) {
    throw ApiError.badRequest("INVALID_ARCHIVE_PATH", "归档路径无效");
  }

  const inner = rawInner
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("\\");

  if (inner.split("\\").some((part) => part === "..")) {
    throw ApiError.badRequest("INVALID_ARCHIVE_PATH", "归档内路径不能包含 ..");
  }

  return { archive, inner };
}

export function buildArchivePath(archive: string, inner: string): string {
  return `${ARCHIVE_SCHEME}${archive}${SEPARATOR}${inner}`;
}

/** Parent path inside the archive, or null at the archive root. */
export function archiveParent(target: string): string | null {
  const { archive, inner } = parseArchivePath(target);
  if (!inner) return null;
  const parts = inner.split("\\");
  parts.pop();
  return buildArchivePath(archive, parts.join("\\"));
}

export function archiveName(target: string): string {
  const { inner } = parseArchivePath(target);
  if (!inner) return "";
  return inner.split("\\").pop() ?? "";
}
