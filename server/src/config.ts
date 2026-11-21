import { APP_NAME, APP_VERSION, DEFAULT_API_PORT } from "@oriel/shared";

export const config = {
  appName: APP_NAME,
  appVersion: APP_VERSION,
  host: process.env.ORIEL_HOST ?? "127.0.0.1",
  port: Number(process.env.ORIEL_PORT ?? DEFAULT_API_PORT),
  /**
   * Extra browser origins allowed through CORS. Tauri and the Vite dev server
   * are always allowed; this is only for exotic dev setups.
   */
  extraOrigins: (process.env.ORIEL_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  /**
   * Optional shared secret. When set, every request needs `X-Api-Token` (or
   * `?token=` for the SSE streams). Leave empty for the usual loopback setup.
   */
  token: (process.env.ORIEL_TOKEN ?? "").trim(),
  /** `owner/name` of the GitHub repository used by the update check. */
  // The packaged app passes its own repository from Rust; the default keeps
  // `npm run dev` honest too.
  updateRepo: (process.env.ORIEL_UPDATE_REPO ?? "Soulmte/Oriel").trim(),
  /**
   * The Gitee mirror of the same repository. It ships the same release assets
   * and is the fallback when the GitHub API or asset hosts are unreachable.
   */
  giteeRepo: (process.env.ORIEL_UPDATE_GITEE ?? "Soulmte/Oriel").trim(),
  /**
   * Optional CDN prefix for release assets, e.g. `https://dl.example.com/oriel`.
   * GitHub asset hosts are unreachable on some networks; with this set the
   * downloader uses `<cdn>/<tag>/<asset name>` instead.
   */
  updateCdn: (process.env.ORIEL_UPDATE_CDN ?? "").trim().replace(/\/+$/, ""),
};
