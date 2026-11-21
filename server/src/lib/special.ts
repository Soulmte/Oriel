import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpecialFolderDto } from "@oriel/shared";

const home = process.env.USERPROFILE ?? os.homedir();
const oneDrive = process.env.OneDrive ?? path.join(home, "OneDrive");
const programFiles =
  process.env.ProgramFiles ?? path.join(process.env.SystemDrive ?? "C:", "Program Files");

/**
 * Known folders can be redirected (OneDrive) or localized (桌面 / 图片).
 * Probe the common locations and keep the first one that exists.
 */
const CANDIDATES: Array<Omit<SpecialFolderDto, "path"> & { paths: string[] }> = [
  {
    id: "home",
    name: "个人",
    icon: "home",
    paths: [home],
  },
  {
    id: "desktop",
    name: "桌面",
    icon: "desktop",
    paths: [
      path.join(home, "Desktop"),
      path.join(oneDrive, "Desktop"),
      path.join(oneDrive, "桌面"),
      path.join(home, "桌面"),
    ],
  },
  {
    id: "documents",
    name: "文稿",
    icon: "documents",
    paths: [
      path.join(home, "Documents"),
      path.join(oneDrive, "Documents"),
      path.join(oneDrive, "文档"),
      path.join(home, "文档"),
    ],
  },
  {
    id: "downloads",
    name: "下载",
    icon: "downloads",
    paths: [
      path.join(home, "Downloads"),
      path.join(oneDrive, "Downloads"),
      path.join(oneDrive, "下载"),
      path.join(home, "下载"),
    ],
  },
  {
    id: "pictures",
    name: "图片",
    icon: "pictures",
    paths: [
      path.join(home, "Pictures"),
      path.join(oneDrive, "Pictures"),
      path.join(oneDrive, "图片"),
      path.join(home, "图片"),
    ],
  },
  {
    id: "music",
    name: "音乐",
    icon: "music",
    paths: [
      path.join(home, "Music"),
      path.join(oneDrive, "Music"),
      path.join(oneDrive, "音乐"),
      path.join(home, "音乐"),
    ],
  },
  {
    id: "videos",
    name: "影片",
    icon: "videos",
    paths: [
      path.join(home, "Videos"),
      path.join(oneDrive, "Videos"),
      path.join(oneDrive, "视频"),
      path.join(home, "视频"),
    ],
  },
  {
    id: "applications",
    name: "应用程序",
    icon: "applications",
    paths: [programFiles],
  },
  {
    id: "tmp",
    name: "临时文件",
    icon: "tmp",
    paths: [os.tmpdir()],
  },
];

async function existsAsDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function listSpecialFolders(): Promise<SpecialFolderDto[]> {
  const resolved = await Promise.all(
    CANDIDATES.map(async (candidate) => {
      for (const candidatePath of candidate.paths) {
        if (await existsAsDirectory(candidatePath)) {
          return {
            id: candidate.id,
            name: candidate.name,
            icon: candidate.icon,
            path: candidatePath,
          } satisfies SpecialFolderDto;
        }
      }
      return null;
    }),
  );

  return resolved.filter((entry): entry is SpecialFolderDto => entry !== null);
}
