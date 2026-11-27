import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import type { SFIconProps } from "sf-symbols-lib/dualtone";
import {
  SFAppGrid,
  SFCpu,
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
  SFSidebarLeft,
  SFSidebarRight,
  SFSparkles,
  SFTrashFill,
  SFXmarkBinFill,
} from "sf-symbols-lib/dualtone";
import { Meter } from "@heroui/react";
import { clsx } from "clsx";
import type { DriveKind } from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { useDropTarget } from "../hooks/useDropTarget";
import { dragKind } from "../lib/dnd";
import { formatBytes, samePath, startsWithPath } from "../lib/format";

const SPECIAL_ICONS: Record<
  string,
  { Icon: ComponentType<SFIconProps>; tint: string }
> = {
  home: { Icon: SFHouseFill, tint: "text-[var(--folder-tint)]" },
  desktop: { Icon: SFDesktopcomputer, tint: "text-[#8e8e93]" },
  documents: { Icon: SFFolderFill, tint: "text-[var(--folder-tint)]" },
  downloads: { Icon: SFFolderFill, tint: "text-[var(--folder-tint)]" },
  pictures: { Icon: SFPhotoFill, tint: "text-[#ff7a8a]" },
  music: { Icon: SFMusicNote, tint: "text-[#ff5f8f]" },
  videos: { Icon: SFFilmFill, tint: "text-[#b48bff]" },
  applications: { Icon: SFAppGrid, tint: "text-[#0a84ff]" },
  tmp: { Icon: SFFolderFill, tint: "text-[#98989f]" },
};

/** Fixed, removable and network volumes read as different things at a glance. */
const DRIVE_ICONS: Record<DriveKind, { Icon: ComponentType<SFIconProps>; tint: string }> = {
  fixed: { Icon: SFInternaldriveFill, tint: "text-[#98989f]" },
  removable: { Icon: SFExternaldriveFill, tint: "text-[var(--folder-tint)]" },
  network: { Icon: SFNetwork, tint: "text-[#5e5ce6]" },
  unknown: { Icon: SFExternaldriveFill, tint: "text-[#98989f]" },
};

const MIN_WIDTH = 180;
const MAX_WIDTH = 320;
const DEFAULT_WIDTH = 224;
const WIDTH_KEY = "oriel:pref-sidebar-width";
const COLLAPSED_WIDTH = 56;
const COLLAPSED_KEY = "oriel:pref-sidebar-collapsed";

const SECTION_CLASS =
  "px-2 pb-1 pt-5 text-[11px] font-semibold tracking-[0.01em] text-mac-muted";

function clampWidth(value: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

function readWidth(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampWidth(raw) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function SidebarItem({
  active,
  icon,
  label,
  title,
  trailing,
  onSelect,
  dropPath,
  compact = false,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  /** Full path or extra detail, shown on hover. */
  title?: string;
  /** Small muted text on the right, e.g. free space. */
  trailing?: React.ReactNode;
  onSelect: () => void;
  /** When set, dropping items on this row moves them into that folder. */
  dropPath?: string;
  /** Icon-only rail mode. */
  compact?: boolean;
}) {
  const dropPaths = useExplorer((state) => state.dropPaths);
  const go = useExplorer((state) => state.go);

  const drop = useDropTarget({
    enabled: Boolean(dropPath),
    onDrop: (paths, event) => {
      if (dropPath) void dropPaths(paths, dropPath, dragKind(event));
    },
    onHover: () => {
      if (dropPath) go(dropPath);
    },
  });

  return (
    <button
      type="button"
      onClick={onSelect}
      title={title ?? label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      {...drop.dropProps}
      className={clsx(
        "group flex h-[30px] w-full items-center rounded-[6px] text-left text-[13px] leading-4 transition-colors",
        compact ? "justify-center px-0" : "gap-2.5 px-2",
        "outline-none focus-visible:ring-2 focus-visible:ring-mac-blue/60",
        drop.active
          ? "bg-mac-blue/25 ring-1 ring-inset ring-mac-blue"
          : active
            ? "bg-black/[0.085] font-medium text-mac-text dark:bg-white/[0.13]"
            : "text-mac-text hover:bg-black/[0.045] dark:hover:bg-white/[0.06]",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center">{icon}</span>
      {!compact && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!compact && trailing && (
        <span className="shrink-0 text-[10.5px] tabular-nums text-mac-muted">
          {trailing}
        </span>
      )}
    </button>
  );
}

export function Sidebar() {
  const route = useExplorer((state) => state.route);
  const path = useExplorer((state) => state.path);
  const layout = useExplorer((state) => state.layout);
  const paneActivePath = useExplorer((state) => state.paneActivePath);
  const specials = useExplorer((state) => state.specials);
  const sidebarFavorites = useExplorer((state) => state.sidebarFavorites);
  const drives = useExplorer((state) => state.drives);
  const platform = useExplorer((state) => state.system?.platform ?? "win32");
  const go = useExplorer((state) => state.go);
  const openSettings = useExplorer((state) => state.openSettings);
  const openRecycle = useExplorer((state) => state.openRecycle);
  const openHome = useExplorer((state) => state.openHome);
  const openProcesses = useExplorer((state) => state.openProcesses);
  const openPorts = useExplorer((state) => state.openPorts);
  const openCleanup = useExplorer((state) => state.openCleanup);
  const openUninstaller = useExplorer((state) => state.openUninstaller);
  const layoutEpoch = useExplorer((state) => state.layoutEpoch);
  const displayPath = layout === "1" ? path : paneActivePath || path;

  const [width, setWidth] = useState(readWidth);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const widthRef = useRef(width);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  widthRef.current = width;

  const currentDrive = useMemo(() => {
    if (!displayPath) return undefined;
    return drives
      .filter((drive) => startsWithPath(displayPath, drive.path, platform))
      .sort((a, b) => b.path.length - a.path.length)[0];
  }, [drives, displayPath, platform]);

  // Two unlabelled volumes are both called “本地磁盘”; the drive letter is the
  // only thing that tells them apart, so add it when the label is ambiguous.
  const driveLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const drive of drives) {
      const label = drive.label || drive.name;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const labels = new Map<string, string>();
    for (const drive of drives) {
      const label = drive.label || drive.name;
      labels.set(
        drive.path,
        (counts.get(label) ?? 0) > 1 ? `${label} (${drive.name})` : label,
      );
    }
    return labels;
  }, [drives]);

  const usage = currentDrive?.total
    ? Math.min(100, Math.max(0, (currentDrive.used / currentDrive.total) * 100))
    : 0;
  const meterColor: "accent" | "warning" | "danger" =
    usage >= 90 ? "danger" : usage >= 70 ? "warning" : "accent";

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // The rail still works for this session.
      }
      return next;
    });
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || collapsed) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or already-released pointer: dragging still works via events.
    }
    dragRef.current = { startX: event.clientX, startWidth: width };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setWidth(clampWidth(drag.startWidth + (event.clientX - drag.startX)));
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore: the pointer was already released.
    }
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    try {
      localStorage.setItem(WIDTH_KEY, String(widthRef.current));
    } catch {
      // Storage disabled: the width just will not persist.
    }
  };

  useEffect(() => {
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  // "重置布局" in the settings bumps this counter.
  useEffect(() => {
    if (layoutEpoch === 0) return;
    setWidth(DEFAULT_WIDTH);
    setCollapsed(false);
    try {
      localStorage.setItem(WIDTH_KEY, String(DEFAULT_WIDTH));
      localStorage.setItem(COLLAPSED_KEY, "0");
    } catch {
      // Ignore.
    }
  }, [layoutEpoch]);

  const sectionSeparator = (
    <div className="mx-2 mb-1.5 mt-2 h-px bg-mac-line" aria-hidden="true" />
  );

  return (
    <aside
      style={{ width: collapsed ? COLLAPSED_WIDTH : width }}
      className="relative flex shrink-0 flex-col border-r border-mac-line bg-mac-sidebar/85 backdrop-blur-2xl"
    >
      <div
        className={clsx(
          "flex shrink-0 items-center px-2 pt-2",
          collapsed ? "justify-center" : "justify-end",
        )}
      >
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "展开边栏" : "收起边栏"}
          title={collapsed ? "展开边栏" : "收起边栏"}
          className="grid size-6 place-items-center rounded-[5px] text-mac-muted outline-none transition-colors hover:bg-black/[0.06] hover:text-mac-text focus-visible:ring-2 focus-visible:ring-mac-blue/60 dark:hover:bg-white/[0.09]"
        >
          {collapsed ? <SFSidebarRight size={13} /> : <SFSidebarLeft size={13} />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1.5">
        <div className="mb-0.5 flex flex-col gap-0.5">
          <SidebarItem
            active={route === "home"}
            label="首页"
            title="常用位置、磁盘与最近打开"
            onSelect={openHome}
            compact={collapsed}
            icon={<SFHouseFill size={16} className="shrink-0 text-[var(--folder-tint)]" />}
          />
        </div>

        {sidebarFavorites && (
          <>
            {collapsed ? sectionSeparator : <p className={SECTION_CLASS}>收藏</p>}
            <div className="flex flex-col gap-0.5">
              {specials.map((folder) => {
                const spec = SPECIAL_ICONS[folder.icon] ?? {
                  Icon: SFFolderFill,
                  tint: "text-[var(--folder-tint)]",
                };
                const active =
                  route === "files" && samePath(displayPath, folder.path, platform);
                return (
                  <SidebarItem
                    key={folder.id}
                    active={active}
                    label={folder.name}
                    title={folder.path}
                    dropPath={folder.path}
                    onSelect={() => go(folder.path)}
                    compact={collapsed}
                    icon={
                      <spec.Icon size={16} className={clsx("shrink-0", spec.tint)} />
                    }
                  />
                );
              })}
            </div>
          </>
        )}

        {collapsed ? sectionSeparator : <p className={SECTION_CLASS}>位置</p>}
        <div className="flex flex-col gap-0.5">
          {drives.length === 0 && !collapsed && (
            <p className="px-2 py-1 text-[11px] text-mac-muted">未检测到磁盘</p>
          )}
          {drives.map((drive) => {
            const active =
              route === "files" && samePath(displayPath, drive.path, platform);
            const icon = DRIVE_ICONS[drive.kind] ?? DRIVE_ICONS.unknown;
            const filled = drive.total > 0;
            const percent = filled
              ? Math.round((drive.used / drive.total) * 100)
              : 0;
            const detail = filled
              ? `${drive.name} · 可用 ${formatBytes(drive.free)} / 共 ${formatBytes(drive.total)}`
              : drive.name;

            return (
              <SidebarItem
                key={drive.path}
                active={active}
                label={driveLabels.get(drive.path) ?? drive.label ?? drive.name}
                title={detail}
                dropPath={drive.path}
                onSelect={() => go(drive.path)}
                compact={collapsed}
                icon={<icon.Icon size={16} className={clsx("shrink-0", icon.tint)} />}
                trailing={
                  filled ? (
                    <span
                      className={clsx(
                        percent >= 90 && "font-medium text-[#ff9f0a]",
                      )}
                    >
                      {formatBytes(drive.free)}
                    </span>
                  ) : undefined
                }
              />
            );
          })}

          <SidebarItem
            active={route === "recycle"}
            label="废纸篓"
            title="Windows 回收站"
            onSelect={() => void openRecycle()}
            compact={collapsed}
            icon={<SFTrashFill size={16} className="shrink-0 text-[#98989f]" />}
          />
        </div>

        {collapsed ? sectionSeparator : <p className={SECTION_CLASS}>工具</p>}
        <div className="flex flex-col gap-0.5">
          <SidebarItem
            active={route === "processes"}
            label="进程管理器"
            title="查看全部进程、内存、CPU，结束进程树"
            onSelect={openProcesses}
            compact={collapsed}
            icon={<SFCpu size={16} className="shrink-0 text-[#5e5ce6]" />}
          />
          <SidebarItem
            active={route === "ports"}
            label="端口进程"
            title="查看并结束占用端口的进程"
            onSelect={openPorts}
            compact={collapsed}
            icon={<SFNetwork size={16} className="shrink-0 text-[#5e5ce6]" />}
          />
          <SidebarItem
            active={route === "cleanup"}
            label="磁盘清理"
            title="分析 C 盘占用并清理临时文件、缓存与回收站"
            onSelect={openCleanup}
            compact={collapsed}
            icon={<SFSparkles size={16} className="shrink-0 text-[#30d158]" />}
          />
          <SidebarItem
            active={route === "uninstaller"}
            label="卸载工具"
            title="运行卸载程序，并清理注册表与文件残留"
            onSelect={openUninstaller}
            compact={collapsed}
            icon={<SFXmarkBinFill size={16} className="shrink-0 text-[#ff453a]" />}
          />
        </div>
      </div>

      <div
        className={clsx(
          "flex flex-col gap-2 border-t border-mac-line",
          collapsed ? "items-center p-2" : "p-2.5 pt-2",
        )}
      >
        {!collapsed && currentDrive && currentDrive.total > 0 && (
          <div
            role="button"
            tabIndex={0}
            title={`${currentDrive.name} · 已用 ${formatBytes(currentDrive.used)} / 共 ${formatBytes(currentDrive.total)}`}
            onClick={() => go(currentDrive.path)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                go(currentDrive.path);
              }
            }}
            className="cursor-default rounded-[8px] bg-black/[0.04] p-2.5 outline-none transition-colors hover:bg-black/[0.07] focus-visible:ring-2 focus-visible:ring-mac-blue/60 dark:bg-white/[0.05] dark:hover:bg-white/[0.08]"
          >
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="rounded-[3px] bg-black/[0.08] px-1 py-px font-semibold tabular-nums text-mac-text dark:bg-white/[0.12]">
                {currentDrive.name}
              </span>
              <span className="min-w-0 flex-1 truncate text-mac-muted">
                {currentDrive.label}
              </span>
              <span className="tabular-nums text-mac-muted">{Math.round(usage)}%</span>
            </div>
            <Meter
              aria-label="磁盘使用情况"
              value={usage}
              size="sm"
              color={meterColor}
              className="mt-1.5 w-full gap-1"
            >
              <Meter.Track className="h-[4px] rounded-full bg-black/[0.09] dark:bg-white/12">
                <Meter.Fill className="rounded-full" />
              </Meter.Track>
            </Meter>
            <div className="mt-1 flex items-center justify-between text-[10.5px] tabular-nums text-mac-muted">
              <span>已用 {formatBytes(currentDrive.used)}</span>
              <span>可用 {formatBytes(currentDrive.free)}</span>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={openSettings}
          aria-current={route === "settings" ? "page" : undefined}
          title="设置"
          aria-label="设置"
          className={clsx(
            "flex h-[30px] w-full items-center rounded-[6px] text-[13px] transition-colors",
            collapsed ? "justify-center px-0" : "gap-2.5 px-2",
            "outline-none focus-visible:ring-2 focus-visible:ring-mac-blue/60",
            route === "settings"
              ? "bg-black/[0.085] font-medium text-mac-text dark:bg-white/[0.13]"
              : "text-mac-text hover:bg-black/[0.045] dark:hover:bg-white/[0.06]",
          )}
        >
          <SFGearshapeFill size={16} className="shrink-0 text-[#98989f]" />
          {!collapsed && <span>设置</span>}
        </button>
      </div>

      {/* Drag handle: resize the sidebar like the preview panel. */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧边栏宽度"
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={() => {
            setWidth(DEFAULT_WIDTH);
            try {
              localStorage.setItem(WIDTH_KEY, String(DEFAULT_WIDTH));
            } catch {
              // Ignore.
            }
          }}
          className="group absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize"
        >
          <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-mac-blue/50 group-active:bg-mac-blue" />
        </div>
      )}
    </aside>
  );
}
