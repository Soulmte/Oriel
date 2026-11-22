import type { FastifyPluginAsync } from "fastify";
import os from "node:os";
import path from "node:path";
import type { HealthResponse, SystemInfoDto } from "@oriel/shared";
import { APP_NAME } from "@oriel/shared";
import { config } from "../config.js";
import { listDrives } from "../lib/drives.js";
import { listSpecialFolders } from "../lib/special.js";
import { listFonts } from "../lib/fonts.js";
import { ApiError } from "../errors.js";
import { checkForUpdate } from "../lib/update.js";
import { killPortProcess, listPorts } from "../lib/ports.js";
import { createDownload } from "../lib/tasks.js";

export const systemRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async (): Promise<HealthResponse> => ({
    ok: true,
    name: APP_NAME,
    version: config.appVersion,
    uptime: process.uptime(),
  }));

  app.get("/system/info", async (): Promise<SystemInfoDto> => ({
    platform: process.platform,
    release: os.release(),
    hostname: os.hostname(),
    home: os.homedir(),
    sep: path.sep,
    appVersion: config.appVersion,
    nodeVersion: process.version,
  }));

  app.get("/drives", async () => listDrives());

  app.get("/special", async () => listSpecialFolders());

  /** Installed font families, used by the appearance settings. */
  app.get("/system/fonts", async () => ({ fonts: await listFonts() }));

  /** Listening TCP/UDP endpoints and their owning processes. */
  app.get("/system/ports", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return listPorts(query.refresh === "1" || query.refresh === "true");
  });

  /** Ends the process that owns a port. Refuses Oriel's own processes. */
  app.post("/system/ports/kill", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const pid = Number(body.pid);
    await killPortProcess(pid);
    return { ok: true as const, pid };
  });

  /** Latest GitHub release, used by the update section in the settings. */
  app.get("/app/update", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    // “重新检查” must hit the network instead of replaying the 10-minute cache.
    return checkForUpdate(query.refresh === "1" || query.refresh === "true");
  });

  /** Downloads a release asset into the temp folder, with real progress. */
  app.post("/app/update/download", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "update";
    const raw = Array.isArray(body.urls)
      ? body.urls.filter((value): value is string => typeof value === "string")
      : typeof body.url === "string"
        ? [body.url]
        : [];
    const urls = [...new Set(raw.map((value) => value.trim()))]
      .filter((value) => /^https?:\/\//i.test(value))
      .slice(0, 3);

    if (urls.length === 0) {
      throw ApiError.badRequest("INVALID_URL", "下载地址无效");
    }

    return createDownload(urls, name);
  });
};
