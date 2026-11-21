import os from "node:os";
import path from "node:path";
import { ERROR_CODES } from "@oriel/shared";
import { ApiError } from "../errors.js";

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]+\\[^\\]+/;
const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;
const RESERVED_WINDOWS_NAMES =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Validate and normalize an absolute path coming from an untrusted client. */
export function normalizePath(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw ApiError.badRequest(ERROR_CODES.invalidPath, "缺少路径参数");
  }

  const raw = input.trim();
  if (raw.includes("\0")) {
    throw ApiError.badRequest(ERROR_CODES.invalidPath, "路径包含非法字符");
  }

  if (process.platform === "win32") {
    if (!WINDOWS_DRIVE.test(raw) && !WINDOWS_UNC.test(raw)) {
      throw ApiError.badRequest(ERROR_CODES.invalidPath, "路径必须是绝对路径");
    }
    return path.win32.resolve(raw);
  }

  if (!raw.startsWith("/")) {
    throw ApiError.badRequest(ERROR_CODES.invalidPath, "路径必须是绝对路径");
  }
  return path.resolve(raw);
}

/** Validate a single file or folder name (no separators, no reserved names). */
export function validateEntryName(input: unknown): string {
  if (typeof input !== "string") {
    throw ApiError.badRequest(ERROR_CODES.invalidName, "名称不能为空");
  }

  const name = input.trim();
  if (!name || name === "." || name === "..") {
    throw ApiError.badRequest(ERROR_CODES.invalidName, "名称不能为空");
  }
  if (INVALID_NAME_CHARS.test(name)) {
    throw ApiError.badRequest(ERROR_CODES.invalidName, '名称不能包含 \\ / : * ? " < > |');
  }
  if (process.platform === "win32") {
    if (/[. ]$/.test(name)) {
      throw ApiError.badRequest(ERROR_CODES.invalidName, "名称不能以空格或句点结尾");
    }
    if (RESERVED_WINDOWS_NAMES.test(name)) {
      throw ApiError.badRequest(ERROR_CODES.invalidName, "该名称是 Windows 保留名称");
    }
  }
  return name;
}

export function parentOf(target: string): string | null {
  const root = path.parse(target).root;
  return target === root ? null : path.dirname(target);
}

/** True when `parent` equals `child` or contains it. */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isSamePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function isFilesystemRoot(target: string): boolean {
  const resolved = path.resolve(target);
  return path.parse(resolved).root === resolved;
}

/**
 * Directories whose removal would wreck the OS or the running service. Only the
 * directory itself is protected: deleting something *inside* Program Files is a
 * normal uninstall step and stays allowed.
 */
function protectedDirectories(): string[] {
  const env = process.env;
  const candidates = [
    env.SystemRoot,
    env.windir,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramData,
    env.USERPROFILE,
    os.homedir(),
    process.cwd(),
  ];

  return candidates.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
}

/** Refuse operations that would take down the machine or the API itself. */
export function assertSafeToDelete(target: string): void {
  if (isFilesystemRoot(target)) {
    throw ApiError.forbidden(ERROR_CODES.unsafeOperation, "不能删除磁盘根目录");
  }

  for (const guarded of protectedDirectories()) {
    if (isSamePath(target, guarded)) {
      throw ApiError.forbidden(
        ERROR_CODES.unsafeOperation,
        `“${guarded}” 是系统或服务目录，不能删除`,
      );
    }
  }
}

/** True when the path is one of the guarded system/service directories. */
export function isProtectedDirectory(target: string): boolean {
  return protectedDirectories().some((guarded) => isSamePath(target, guarded));
}
