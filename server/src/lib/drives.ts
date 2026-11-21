import { execFile } from "node:child_process";
import { fs } from "./native-fs.js";
import path from "node:path";
import { promisify } from "node:util";
import type { DriveDto, DriveKind } from "@oriel/shared";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 30_000;

interface RawWindowsDrive {
  DeviceID?: string;
  VolumeName?: string | null;
  DriveType?: number;
  Size?: number | null;
  FreeSpace?: number | null;
}

let cache: { at: number; drives: DriveDto[] } | null = null;

function kindFromWindowsType(type: number | undefined): DriveKind {
  switch (type) {
    case 3:
      return "fixed";
    case 2:
      return "removable";
    case 4:
      return "network";
    default:
      return "unknown";
  }
}

async function listWindowsDrives(): Promise<DriveDto[]> {
  const script =
    "Get-CimInstance Win32_LogicalDisk | " +
    "Select-Object DeviceID,VolumeName,DriveType,Size,FreeSpace | " +
    "ConvertTo-Json -Compress";

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { timeout: 8_000, windowsHide: true },
    );

    const raw = JSON.parse(stdout.replace(/^\uFEFF/, "").trim() || "[]");
    const list: RawWindowsDrive[] = Array.isArray(raw) ? raw : [raw];

    return list
      .filter((drive) => typeof drive.DeviceID === "string" && drive.DeviceID)
      .map((drive) => {
        const root = `${drive.DeviceID}\\`;
        const total = Number(drive.Size ?? 0);
        const free = Number(drive.FreeSpace ?? 0);
        return {
          path: root,
          name: drive.DeviceID ?? root,
          label: drive.VolumeName || defaultDriveLabel(root),
          total,
          free,
          used: Math.max(0, total - free),
          kind: kindFromWindowsType(drive.DriveType),
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return listWindowsDrivesFallback();
  }
}

function defaultDriveLabel(root: string): string {
  return root.toUpperCase().startsWith("C:") ? "Windows" : "本地磁盘";
}

async function listWindowsDrivesFallback(): Promise<DriveDto[]> {
  const letters = "CDEFGHIJKLMNOPQRSTUVWXYZAB".split("");
  const drives: DriveDto[] = [];

  await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        const stat = await fs.statfs(root);
        const total = Number(stat.blocks) * Number(stat.bsize);
        const free = Number(stat.bavail) * Number(stat.bsize);
        drives.push({
          path: root,
          name: `${letter}:`,
          label: defaultDriveLabel(root),
          total,
          free,
          used: Math.max(0, total - free),
          kind: "unknown",
        });
      } catch {
        // Drive letter not mounted.
      }
    }),
  );

  return drives.sort((a, b) => a.path.localeCompare(b.path));
}

async function listUnixDrives(): Promise<DriveDto[]> {
  try {
    const stat = await fs.statfs("/");
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return [
      {
        path: "/",
        name: "/",
        label: "File System",
        total,
        free,
        used: Math.max(0, total - free),
        kind: "fixed",
      },
    ];
  } catch {
    return [];
  }
}

export async function listDrives(force = false): Promise<DriveDto[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.drives;
  }

  const drives =
    process.platform === "win32"
      ? await listWindowsDrives()
      : await listUnixDrives();

  cache = { at: Date.now(), drives };
  return drives;
}

/** Find the drive that contains `target` (longest matching prefix). */
export function driveForPath(
  drives: DriveDto[],
  target: string,
): DriveDto | undefined {
  const lowered = target.toLowerCase();
  return drives
    .filter((drive) => lowered.startsWith(drive.path.toLowerCase()))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function isDriveRoot(target: string): boolean {
  const parsed = path.parse(target);
  return parsed.root === target;
}
