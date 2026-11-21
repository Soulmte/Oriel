import type { ApiErrorBody } from "@oriel/shared";
import { ERROR_CODES } from "@oriel/shared";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }

  static badRequest(code: string, message: string): ApiError {
    return new ApiError(400, code, message);
  }

  static forbidden(code: string, message: string): ApiError {
    return new ApiError(403, code, message);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, ERROR_CODES.notFound, message);
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, ERROR_CODES.conflict, message);
  }
}

/** Translate a Node fs error into a user-facing API error. */
export function fromFsError(error: unknown, target?: string): ApiError {
  if (error instanceof ApiError) return error;

  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const suffix = target ? `：${target}` : "";

  switch (code) {
    case "ENOENT":
      return new ApiError(404, ERROR_CODES.notFound, `路径不存在${suffix}`);
    case "EACCES":
    case "EPERM":
      return new ApiError(403, ERROR_CODES.permissionDenied, `没有权限访问${suffix}`);
    case "ENOTDIR":
      return new ApiError(400, ERROR_CODES.notADirectory, `路径不是文件夹${suffix}`);
    case "EEXIST":
      return ApiError.conflict(`目标已存在${suffix}`);
    case "EBUSY":
      return ApiError.conflict(`文件正在被使用${suffix}`);
    case "ENOSPC":
      return new ApiError(507, "NO_SPACE", "磁盘空间不足");
    case "EXDEV":
      return ApiError.badRequest(ERROR_CODES.invalidTarget, "不能跨磁盘移动");
    default:
      return new ApiError(500, ERROR_CODES.internal, "服务器内部错误");
  }
}

export function errorBody(error: ApiError): ApiErrorBody {
  return { error: { code: error.code, message: error.message } };
}
