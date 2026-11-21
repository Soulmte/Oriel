import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { ERROR_CODES } from "@oriel/shared";
import { ApiError, errorBody, fromFsError } from "./errors.js";
import { config } from "./config.js";
import { isAllowedOrigin } from "./lib/cors.js";
import { systemRoutes } from "./routes/system.js";
import { fsRoutes } from "./routes/fs.js";

function mapError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  if (errno) return fromFsError(error);

  const message = error instanceof Error ? error.message : "服务器内部错误";
  const statusCode = (error as FastifyError | undefined)?.statusCode ?? 500;
  if (statusCode < 500) {
    return new ApiError(statusCode, "BAD_REQUEST", message);
  }
  return new ApiError(500, ERROR_CODES.internal, "服务器内部错误");
}

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : { level: process.env.LOG_LEVEL ?? "info" },
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      // Allowed origins get their headers reflected; the rest simply get none.
      // The onRequest hook below then refuses the request outright, which is
      // what stops a malicious page from reaching a route at all.
      callback(null, origin ? isAllowedOrigin(origin) : false);
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Api-Token"],
  });

  /**
   * Defence in depth for browsers: a CORS preflight failure is enough to stop a
   * cross-site POST, but a plain GET would still run server-side. Refusing the
   * request outright closes that hole too. Non-browser clients (curl, the smoke
   * test) send no Origin and stay allowed; the optional token covers them.
   */
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
      return reply.code(403).send({
        error: { code: "ORIGIN_NOT_ALLOWED", message: "不允许的来源" },
      });
    }

    if (!config.token) return;

    // `request.query` is not parsed yet in onRequest, and EventSource cannot set
    // headers, so the token may arrive either as a header or as `?token=`.
    let queryToken: string | null = null;
    try {
      queryToken = new URL(request.url, "http://localhost").searchParams.get("token");
    } catch {
      queryToken = null;
    }

    const provided = request.headers["x-api-token"] ?? queryToken ?? undefined;

    if (provided !== config.token) {
      return reply.code(401).send({
        error: { code: "UNAUTHORIZED", message: "缺少访问令牌" },
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const apiError = mapError(error);
    if (apiError.statusCode >= 500) {
      request.log.error(error);
    }
    return reply.code(apiError.statusCode).send(errorBody(apiError));
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api")) {
      return reply.code(404).send({
        error: { code: ERROR_CODES.notFound, message: "接口不存在" },
      });
    }
    return reply.code(404).send({ error: "Not Found" });
  });

  await app.register(systemRoutes, { prefix: "/api" });
  await app.register(fsRoutes, { prefix: "/api" });

  return app;
}
