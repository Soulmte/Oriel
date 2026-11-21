import { config } from "../config.js";

/**
 * Origin policy for the local REST service.
 *
 * The service can read, move and delete any file the user can touch, so it must
 * not be reachable from an arbitrary web page. Only the Vite dev server, Tauri's
 * webview origins and anything explicitly listed in `ORIEL_ORIGINS` are
 * allowed; everything else is refused before it reaches a route.
 */

const TAURI_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

/** Vite is pinned to this port by `strictPort: true`. */
const DEV_ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

export function isAllowedOrigin(origin: string): boolean {
  if (config.extraOrigins.includes(origin)) return true;
  if (TAURI_ORIGINS.has(origin)) return true;
  if (DEV_ORIGINS.has(origin)) return true;
  return false;
}

/**
 * CORS headers for hijacked (SSE) replies that bypass the Fastify hook.
 * A missing origin means a non-browser client; echoing nothing is correct there.
 */
export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !isAllowedOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}
