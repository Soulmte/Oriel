/**
 * Archive virtual paths: `archive://D:\a.zip|docs\readme.txt`.
 * Mirrors `server/src/lib/archive-path.ts`; the `|` separator cannot appear in
 * a Windows path, so no escaping is needed.
 */

export const ARCHIVE_SCHEME = "archive://";
const SEPARATOR = "|";

export interface ArchiveLocation {
  archive: string;
  /** Entry inside the archive, backslash separated, "" for the root. */
  inner: string;
}

export function isArchivePath(target: string | null | undefined): boolean {
  return typeof target === "string" && target.startsWith(ARCHIVE_SCHEME);
}

export function parseArchivePath(target: string): ArchiveLocation {
  const body = target.slice(ARCHIVE_SCHEME.length);
  const index = body.indexOf(SEPARATOR);
  const archive = index === -1 ? body : body.slice(0, index);
  const inner = index === -1 ? "" : body.slice(index + 1);
  return { archive, inner: inner.replace(/\//g, "\\").replace(/^\\+/, "") };
}

export function buildArchivePath(archive: string, inner: string): string {
  return `${ARCHIVE_SCHEME}${archive}${SEPARATOR}${inner}`;
}

export function archiveParent(target: string): string | null {
  const { archive, inner } = parseArchivePath(target);
  if (!inner) return null;
  const parts = inner.split("\\").filter(Boolean);
  parts.pop();
  return buildArchivePath(archive, parts.join("\\"));
}

/** Extensions the app opens as a browsable archive. */
const BROWSABLE_EXTENSIONS = new Set([
  "zip",
  "7z",
  "rar",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
  "iso",
  "cab",
  "jar",
  "apk",
]);

export function isBrowsableArchive(ext: string): boolean {
  return BROWSABLE_EXTENSIONS.has(ext.toLowerCase());
}
