import type { ComponentType } from "react";
import type { SFIconProps } from "sf-symbols-lib/dualtone";
import {
  SFAppGrid,
  SFArrowClockwise,
  SFDesktopcomputer,
  SFExternaldriveFill,
  SFFilmFill,
  SFFolderFill,
  SFGearshapeFill,
  SFHouseFill,
  SFInternaldriveFill,
  SFMusicNote,
  SFNetwork,
  SFPhotoFill,
  SFTrashFill,
} from "sf-symbols-lib/dualtone";
import { Button } from "@heroui/react";
import { clsx } from "clsx";
import type { DriveKind } from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { formatBytes } from "../lib/format";

const SPECIAL_ICONS: Record<
  string,
  { Icon: ComponentType<SFIconProps>; tint: string }
> = {
  home: { Icon: SFHouseFill, tint: "text-[#3d9bff]" },
  desktop: { Icon: SFDesktopcomputer, tint: "text-[#8e8e93]" },
  documents: { Icon: SFFolderFill, tint: "text-[#3d9bff]" },
  downloads: { Icon: SFFolderFill, tint: "text-[#3d9bff]" },
  pictures: { Icon: SFPhotoFill, tint: "text-[#ff7a8a]" },
  music: { Icon: SFMusicNote, tint: "text-[#ff5f8f]" },
  videos: { Icon: SFFilmFill, tint: "text-[#b48bff]" },
  applications: { Icon: SFAppGrid, tint: "text-[#0a84ff]" },
  tmp: { Icon: SFFolderFill, tint: "text-[#98989f]" },
};

const DRIVE_ICONS: Record<DriveKind, { Icon: ComponentType<SFIconProps>; tint: string }> = {
  fixed: { Icon: SFInternaldriveFill, tint: "text-[#98989f]" },
  removable: { Icon: SFExternaldriveFill, tint: "text-[#3d9bff]" },
  network: { Icon: SFNetwork, tint: "text-[#5e5ce6]" },
  unknown: { Icon: SFExternaldriveFill, tint: "text-[#98989f]" },
};

const TILE_CLASS =
  "group flex items-center gap-3 rounded-[12px] border border-mac-line/70 bg-black/[0.02] px-3.5 py-3 text-left " +
  "transition-colors hover:bg-black/[0.045] dark:bg-white/[0.035] dark:hover:bg-white/[0.07]";

function SectionHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-2.5 flex items-baseline gap-2 px-0.5">
      <h2 className="text-[12.5px] font-semibold text-mac-text">{title}</h2>
      {hint && <span className="text-[11px] text-mac-muted">{hint}</span>}
    </div>
  );
}

/**
 * Finder-like start page: the places people actually open every day, the
 * volumes with their real capacity, and the folders opened most recently.
 */
export function HomePage() {
  const specials = useExplorer((state) => state.specials);
  const drives = useExplorer((state) => state.drives);
  const recentFolders = useExplorer((state) => state.recentFolders);
  const system = useExplorer((state) => state.system);
  const navigate = useExplorer((state) => state.navigate);
  const openRecycle = useExplorer((state) => state.openRecycle);
  const openSettings = useExplorer((state) => state.openSettings);
  const reloadDrives = useExplorer((state) => state.loadDrives);

  const go = (path: string) => void navigate(path);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-mac-surface">
      <div className="mx-auto w-full max-w-[1040px] px-8 pb-12 pt-7">
        <header className="mb-7 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-mac-text">
              首页
            </h1>
            <p className="mt-1 truncate text-[12px] text-mac-muted">
              {system?.hostname ? `${system.hostname} · ` : ""}
              常用位置、磁盘与最近打开
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="secondary" onPress={() => void openRecycle()}>
              <SFTrashFill size={14} />
              废纸篓
            </Button>
            <Button size="sm" variant="secondary" onPress={openSettings}>
              <SFGearshapeFill size={14} />
              设置
            </Button>
          </div>
        </header>

        <section className="mb-8">
          <SectionHeading title="常用位置" hint="点击直接打开" />
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {specials.map((folder) => {
              const spec = SPECIAL_ICONS[folder.icon] ?? {
                Icon: SFFolderFill,
                tint: "text-[#3d9bff]",
              };
              return (
                <button
                  key={folder.id}
                  type="button"
                  title={folder.path}
                  onClick={() => go(folder.path)}
                  className={TILE_CLASS}
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-black/[0.05] dark:bg-white/[0.07]">
                    <spec.Icon size={18} className={spec.tint} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] text-mac-text">
                      {folder.name}
                    </span>
                    <span className="block truncate text-[10.5px] text-mac-muted">
                      {folder.path}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="mb-8">
          <div className="mb-2.5 flex items-baseline gap-3 px-0.5">
            <h2 className="text-[12.5px] font-semibold text-mac-text">磁盘</h2>
            <button
              type="button"
              onClick={() => void reloadDrives()}
              className="flex items-center gap-1 text-[11px] text-mac-muted hover:text-mac-text"
            >
              <SFArrowClockwise size={11} />
              刷新
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {drives.map((drive) => {
              const icon = DRIVE_ICONS[drive.kind] ?? DRIVE_ICONS.unknown;
              const percent =
                drive.total > 0 ? Math.round((drive.used / drive.total) * 100) : 0;
              const tight = percent >= 90;
              return (
                <button
                  key={drive.path}
                  type="button"
                  onClick={() => go(drive.path)}
                  className={clsx(TILE_CLASS, "flex-col items-stretch gap-2.5")}
                >
                  <span className="flex items-center gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-[9px] bg-black/[0.05] dark:bg-white/[0.07]">
                      <icon.Icon size={18} className={icon.tint} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] text-mac-text">
                        {drive.label || drive.name}
                      </span>
                      <span className="block truncate text-[10.5px] text-mac-muted">
                        {drive.name} · 可用 {formatBytes(drive.free)} / 共{" "}
                        {formatBytes(drive.total)}
                      </span>
                    </span>
                    <span
                      className={clsx(
                        "shrink-0 text-[11px] tabular-nums text-mac-muted",
                        tight && "text-[#ff9f0a]",
                      )}
                    >
                      {percent}%
                    </span>
                  </span>
                  <span className="h-[5px] overflow-hidden rounded-full bg-black/[0.09] dark:bg-white/12">
                    <span
                      className={clsx(
                        "block h-full rounded-full",
                        tight ? "bg-[#ff9f0a]" : "bg-mac-blue",
                      )}
                      style={{ width: `${Math.min(100, percent)}%` }}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <SectionHeading title="最近打开" />
          {recentFolders.length === 0 ? (
            <p className="rounded-[12px] border border-dashed border-mac-line px-4 py-6 text-center text-[11.5px] text-mac-muted">
              打开过的文件夹会出现在这里
            </p>
          ) : (
            <div className="overflow-hidden rounded-[12px] border border-mac-line/70">
              {recentFolders.map((path, index) => {
                const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
                return (
                  <button
                    key={path}
                    type="button"
                    title={path}
                    onClick={() => go(path)}
                    className={clsx(
                      "flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors",
                      "hover:bg-black/[0.04] dark:hover:bg-white/[0.06]",
                      index > 0 && "border-t border-mac-line/60",
                    )}
                  >
                    <SFFolderFill size={15} className="shrink-0 text-[#3d9bff]" />
                    <span className="w-40 shrink-0 truncate text-[12.5px] text-mac-text">
                      {name}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-mac-muted">
                      {path}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
