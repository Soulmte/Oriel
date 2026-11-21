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

  /** Latest GitHub release, used by the update section in the settings. */
  app.get("/app/update", async () => checkForUpdate());

  /** Downloads a release asset into the temp folder, with real progress. */
  app.post("/app/update/download", async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "update";

    if (!/^https?:\/\//i.test(url)) {
      throw ApiError.badRequest("INVALID_URL", "下载地址无效");
    }

    return createDownload(url, name);
  });
};
