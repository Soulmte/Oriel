import type { UpdateAssetDto } from "@oriel/shared";

/** The installer the updater should download: setup.exe, then any exe/msi. */
export function pickPrimaryAsset(assets: UpdateAssetDto[]): UpdateAssetDto | null {
  if (assets.length === 0) return null;
  return (
    assets.find((asset) => /setup.*\.exe$/i.test(asset.name)) ??
    assets.find((asset) => /\.exe$/i.test(asset.name)) ??
    assets.find((asset) => /\.(msi|msix)$/i.test(asset.name)) ??
    assets[0]
  );
}

/** CDN → Gitee → GitHub, matching the order the backend built. */
export function assetUrls(asset: UpdateAssetDto): string[] {
  const list = asset.urls?.length
    ? asset.urls
    : [asset.url, asset.mirrorUrl, asset.sourceUrl];
  return Array.from(
    new Set(
      list.filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      ),
    ),
  );
}

/** One plain-text line for the update card; release notes are Markdown. */
export function summarizeNotes(notes: string | null | undefined, max = 150): string {
  if (!notes) return "";
  const text = notes
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, " · ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[#*_>`~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
