import {
  createReadStream as nativeReadStream,
  createWriteStream as nativeWriteStream,
  promises as nativeFs,
} from "node:fs";
import type { ReadStream, WriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";

/**
 * Windows long-path support.
 *
 * Without `LongPathsEnabled=1` in the registry (and a `longPathAware` manifest)
 * every Win32 call fails past MAX_PATH. Node ships the manifest, the registry
 * value is the user's call, so paths are prefixed with the `\\?\` namespace
 * escape when they get long — that bypasses the limit regardless.
 *
 * The prefix disables Win32 normalization (`/` separators, `.`/`..`), so it is
 * only applied to paths that are already normalized and actually long. Short
 * paths keep the plain form and behave exactly as before.
 */

const MAX_PATH = 260;
/** Leave headroom for the file name a caller may append. */
const PREFIX_THRESHOLD = 240;

export function toNativePath(target: string): string {
  if (process.platform !== "win32") return target;
  if (target.length < PREFIX_THRESHOLD) return target;
  if (target.startsWith("\\\\?\\")) return target;
  if (target.startsWith("\\\\")) {
    // UNC share: \\server\share → \\?\UNC\server\share
    return `\\\\?\\UNC\\${target.slice(2)}`;
  }
  return `\\\\?\\${target}`;
}

/**
 * Prefixes unconditionally. Used for paths handed to a worker that will join
 * children onto them: the prefix has to be there before the length grows.
 */
export function toNativePathAlways(target: string): string {
  if (process.platform !== "win32") return target;
  if (target.startsWith("\\\\?\\")) return target;
  if (target.startsWith("\\\\")) return `\\\\?\\UNC\\${target.slice(2)}`;
  return `\\\\?\\${target}`;
}

/** Strips the escape again, for anything user-visible. */
export function fromNativePath(target: string): string {
  if (target.startsWith("\\\\?\\UNC\\")) return `\\\\${target.slice(8)}`;
  if (target.startsWith("\\\\?\\")) return target.slice(4);
  return target;
}

export const fs = {
  access: (target: string, mode?: number) => nativeFs.access(toNativePath(target), mode),
  cp: (source: string, destination: string, options?: Parameters<typeof nativeFs.cp>[2]) =>
    nativeFs.cp(toNativePath(source), toNativePath(destination), options),
  lstat: (target: string) => nativeFs.lstat(toNativePath(target)),
  stat: (target: string) => nativeFs.stat(toNativePath(target)),
  statfs: (target: string) => nativeFs.statfs(toNativePath(target)),
  mkdir: (target: string, options?: Parameters<typeof nativeFs.mkdir>[1]) =>
    nativeFs.mkdir(toNativePath(target), options),
  open: (target: string, flags: string | number): Promise<FileHandle> =>
    nativeFs.open(toNativePath(target), flags),
  readdir: ((target: string, options?: unknown) =>
    options === undefined
      ? nativeFs.readdir(toNativePath(target))
      : nativeFs.readdir(toNativePath(target), options as never)) as typeof nativeFs.readdir,
  readFile: ((target: string, options?: unknown) =>
    options === undefined
      ? nativeFs.readFile(toNativePath(target))
      : nativeFs.readFile(toNativePath(target), options as never)) as typeof nativeFs.readFile,
  writeFile: ((target: string, data: unknown, options?: unknown) =>
    nativeFs.writeFile(toNativePath(target), data as never, options as never)) as typeof nativeFs.writeFile,
  rename: (source: string, destination: string) =>
    nativeFs.rename(toNativePath(source), toNativePath(destination)),
  rm: (target: string, options?: Parameters<typeof nativeFs.rm>[1]) =>
    nativeFs.rm(toNativePath(target), options),
  unlink: (target: string) => nativeFs.unlink(toNativePath(target)),
  utimes: (target: string, atime: Date | number, mtime: Date | number) =>
    nativeFs.utimes(toNativePath(target), atime, mtime),
  readlink: (target: string) => nativeFs.readlink(toNativePath(target)),
  symlink: (linkTarget: string, target: string, type?: string) =>
    nativeFs.symlink(
      toNativePath(linkTarget),
      toNativePath(target),
      type as Parameters<typeof nativeFs.symlink>[2],
    ),
};

export function createReadStream(
  target: string,
  options?: Parameters<typeof nativeReadStream>[1],
): ReadStream {
  return nativeReadStream(toNativePath(target), options);
}

export function createWriteStream(
  target: string,
  options?: Parameters<typeof nativeWriteStream>[1],
): WriteStream {
  return nativeWriteStream(toNativePath(target), options);
}
