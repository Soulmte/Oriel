import { APP_VERSION } from "@oriel/shared";
import type { UpdateAssetDto, UpdateInfoDto } from "@oriel/shared";
import { config } from "../config.js";

/**
 * Update check with two release sources.
 *
 * GitHub is the canonical release feed; Gitee mirrors the same assets and is
 * usually reachable when GitHub is not. Both are queried in parallel and their
 * assets are merged by name, so the UI can try the mirror first and fall back
 * to GitHub (or a configured CDN) without a second round trip.
 */

const CACHE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 8000;

interface ReleaseAssetSource {
  name: string;
  url: string;
  size: number;
}

interface ReleaseSource {
  tag: string;
  url: string | null;
  notes: string | null;
  publishedAt: string | null;
  assets: ReleaseAssetSource[];
}

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

interface RawRelease {
  tag_name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  created_at?: string;
  assets?: Array<{
    name?: string;
    browser_download_url?: string;
    size?: number;
  }>;
}

function normalize(
  raw: RawRelease,
  fallbackUrl: string | null,
): ReleaseSource {
  const tag = (raw.tag_name ?? "").trim();
  return {
    tag,
    url:
      raw.html_url ??
      (fallbackUrl && tag
        ? `${fallbackUrl}/tag/${encodeURIComponent(tag)}`
        : fallbackUrl),
    notes: raw.body?.slice(0, 4000) ?? null,
    publishedAt: raw.published_at ?? raw.created_at ?? null,
    assets: (raw.assets ?? [])
      .filter((asset) => asset.name && asset.browser_download_url)
      .map((asset) => ({
        name: asset.name as string,
        url: asset.browser_download_url as string,
        size: Number(asset.size ?? 0),
      })),
  };
}

async function fetchGithub(repo: string): Promise<ReleaseSource> {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "oriel-update-check",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  return normalize(
    (await response.json()) as RawRelease,
    `https://github.com/${repo}/releases`,
  );
}

async function fetchGitee(repo: string): Promise<ReleaseSource> {
  const headers = {
    Accept: "application/json",
    "User-Agent": "oriel-update-check",
  };
  const latest = await fetch(
    `https://gitee.com/api/v5/repos/${repo}/releases/latest`,
    { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (latest.ok) {
    return normalize(
      (await latest.json()) as RawRelease,
      `https://gitee.com/${repo}/releases`,
    );
  }

  // Some Gitee deployments do not expose `/latest`; take the newest one.
  const list = await fetch(
    `https://gitee.com/api/v5/repos/${repo}/releases?page=1&per_page=1&direction=desc`,
    { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!list.ok) throw new Error(`Gitee 返回 ${list.status}`);
  const releases = (await list.json()) as RawRelease[];
  const first = Array.isArray(releases) ? releases[0] : null;
  if (!first) throw new Error("Gitee 还没有发布记录");
  return normalize(first, `https://gitee.com/${repo}/releases`);
}

/** NSIS first, then MSI, then archives/checksums. */
function installerScore(name: string): number {
  if (/setup.*\.exe$/i.test(name)) return 0;
  if (/\.exe$/i.test(name)) return 1;
  if (/\.msi$/i.test(name)) return 2;
  if (/\.(msix|zip|7z)$/i.test(name)) return 3;
  return 4;
}

export async function checkForUpdate(force = false): Promise<UpdateInfoDto> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.info;

  if (!config.updateRepo) return unconfigured();

  const info: UpdateInfoDto = { ...unconfigured(), configured: true };

  const [github, gitee] = await Promise.allSettled([
    fetchGithub(config.updateRepo),
    fetchGitee(config.giteeRepo),
  ]);

  const gh = github.status === "fulfilled" ? github.value : null;
  const gt = gitee.status === "fulfilled" ? gitee.value : null;
  const primary = gh ?? gt;

  if (!primary) {
    const messages = [github, gitee]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) =>
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    info.error = messages.length > 0 ? messages.join("；") : "没有可用的更新源";
    cache = { at: Date.now(), info };
    return info;
  }

  const latest = primary.tag.replace(/^v/i, "") || null;
  info.latest = latest;
  info.url = primary.url;
  info.notes = primary.notes;
  info.publishedAt = primary.publishedAt;
  info.newer = latest ? isNewer(latest, APP_VERSION) : false;

  const ghAssets = new Map((gh?.assets ?? []).map((asset) => [asset.name, asset]));
  const gtAssets = new Map((gt?.assets ?? []).map((asset) => [asset.name, asset]));
  const names = [...new Set([...ghAssets.keys(), ...gtAssets.keys()])];
  const tag = primary.tag;

  info.assets = names
    .map((name): UpdateAssetDto => {
      const githubUrl = ghAssets.get(name)?.url ?? null;
      const giteeUrl = gtAssets.get(name)?.url ?? null;
      const cdnUrl =
        config.updateCdn && tag
          ? `${config.updateCdn}/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
          : null;
      // CDN first, then Gitee, then GitHub: the first two are the ones that
      // work on networks where githubusercontent is unreachable.
      const url = cdnUrl ?? giteeUrl ?? githubUrl ?? "";
      return {
        name,
        size: ghAssets.get(name)?.size ?? gtAssets.get(name)?.size ?? 0,
        url,
        sourceUrl: githubUrl && githubUrl !== url ? githubUrl : null,
        mirrorUrl: giteeUrl && giteeUrl !== url ? giteeUrl : null,
      };
    })
    .filter((asset) => asset.url)
    .sort(
      (a, b) =>
        installerScore(a.name) - installerScore(b.name) ||
        a.name.localeCompare(b.name),
    );

  cache = { at: Date.now(), info };
  return info;
}
