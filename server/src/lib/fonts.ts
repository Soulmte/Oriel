import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fs as nativeFs } from "./native-fs.js";

/**
 * Installed font families.
 *
 * `InstalledFontCollection` is the only reliable source of *family* names
 * ("Microsoft YaHei", "等线") — file names in `Fonts\` are the internal names
 * ("msyh", "Deng"). Windows keeps the list stable for a session, so it is cached
 * and the folder scan is only a fallback when PowerShell is unavailable.
 */

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 10 * 60_000;

// Windows PowerShell writes console output in the OEM code page; without this
// line Chinese family names ("微软雅黑") come back as mojibake.
const POWERSHELL_SCRIPT =
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
  "$OutputEncoding = [System.Text.Encoding]::UTF8; " +
  "Add-Type -AssemblyName System.Drawing; " +
  "(New-Object System.Drawing.Text.InstalledFontCollection).Families | " +
  "ForEach-Object { $_.Name } | ConvertTo-Json -Compress";

let cache: { at: number; fonts: string[] } | null = null;
let inflight: Promise<string[]> | null = null;

function normalize(fonts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const font of fonts) {
    const name = font.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }

  return out.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}

async function readFromPowershell(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_SCRIPT],
    { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
  );

  const raw = stdout.replace(/^\uFEFF/, "").trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw) as string | string[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Fallback: file names in the font folders, minus the extension. */
async function readFromFolders(): Promise<string[]> {
  const roots = [
    path.join(process.env.SystemRoot ?? "C:\\Windows", "Fonts"),
    path.join(os.homedir(), "AppData", "Local", "Microsoft", "Windows", "Fonts"),
  ];

  const names: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await nativeFs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (![".ttf", ".otf", ".ttc", ".fon"].includes(ext)) continue;
      names.push(path.basename(entry, ext));
    }
  }
  return names;
}

export async function listFonts(): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.fonts;
  if (inflight) return inflight;

  inflight = (async () => {
    let fonts: string[] = [];
    if (process.platform === "win32") {
      fonts = await readFromPowershell().catch(() => []);
    }
    if (fonts.length === 0) {
      fonts = await readFromFolders().catch(() => []);
    }
    const normalized = normalize(fonts);
    cache = { at: Date.now(), fonts: normalized };
    return normalized;
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
