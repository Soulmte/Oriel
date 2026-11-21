import { APP_VERSION } from "@oriel/shared";
import type { UpdateInfoDto } from "@oriel/shared";
import { config } from "../config.js";

/**
 * Update check against GitHub releases.
 *
 * The repository is configured with `ORIEL_UPDATE_REPO=owner/name`; when
 * it is not set the endpoint reports `configured: false` instead of pretending
 * there is nothing new.
 */

const CACHE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 8000;

let cache: { at: number; info: UpdateInfoDto } | null = null;

function parseVersion(value: string): number[] {
  return value
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

function unconfigured(): UpdateInfoDto {
  return {
    configured: false,
    current: APP_VERSION,
    latest: null,
    newer: false,
    url: null,
    notes: null,
    publishedAt: null,
    assets: [],
  };
}

export async function checkForUpdate(): Promise<UpdateInfoDto> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.info;

  if (!config.updateRepo) return unconfigured();

  const info: UpdateInfoDto = { ...unconfigured(), configured: true };

  try {
    const response = await fetch(
      `https://api.github.com/repos/${config.updateRepo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "oriel-update-check",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub 返回 ${response.status}`);
    }

    const release = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      published_at?: string;
      assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>;
    };

    const latest = (release.tag_name ?? "").replace(/^v/i, "") || null;
    info.latest = latest;
    info.url = release.html_url ?? null;
    info.notes = release.body?.slice(0, 4000) ?? null;
    info.publishedAt = release.published_at ?? null;
    info.newer = latest ? isNewer(latest, APP_VERSION) : false;
    const tag = (release.tag_name ?? "").trim();
    const cdn = config.updateCdn;

    info.assets = (release.assets ?? [])
      .filter((asset) => asset.name && asset.browser_download_url)
      .map((asset) => ({
        name: asset.name as string,
        url:
          cdn && tag
            ? `${cdn}/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name as string)}`
            : (asset.browser_download_url as string),
        size: Number(asset.size ?? 0),
      }))
      // Installers first, checksums last.
      .sort((a, b) => {
        const score = (name: string) =>
          /\.(exe|msi|msix|zip|7z)$/i.test(name) ? 0 : 1;
        return score(a.name) - score(b.name) || a.name.localeCompare(b.name);
      });
  } catch (error) {
    info.error = error instanceof Error ? error.message : String(error);
  }

  cache = { at: Date.now(), info };
  return info;
}
