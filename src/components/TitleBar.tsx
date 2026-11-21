import { useMemo } from "react";
import type { ReactNode } from "react";
import { SFMinus, SFSquare, SFXmark } from "sf-symbols-lib/dualtone";
import { clsx } from "clsx";
import { useExplorer } from "../store/explorer";
import { basename } from "../lib/format";
import { isArchivePath, parseArchivePath } from "../lib/archivePath";
import {
  closeWindow,
  minimizeWindow,
  toggleMaximizeWindow,
} from "../lib/window";

function CaptionButton({
  label,
  onPress,
  danger,
  children,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onPress}
      className={clsx(
        "grid h-full w-11 place-items-center text-mac-muted transition-colors",
        danger
          ? "hover:bg-[#e81123] hover:text-white"
          : "hover:bg-black/[0.06] hover:text-mac-text dark:hover:bg-white/[0.09]",
      )}
    >
      {children}
    </button>
  );
}

export function TitleBar() {
  const route = useExplorer((state) => state.route);
  const path = useExplorer((state) => state.path);
  const drives = useExplorer((state) => state.drives);

  const title = useMemo(() => {
    if (route === "settings") return "设置";
    if (route === "recycle") return "废纸篓";
    if (!path) return "Oriel";
    if (isArchivePath(path)) {
      const { archive, inner } = parseArchivePath(path);
      const archiveName = basename(archive);
      const leaf = inner.split("\\").filter(Boolean).pop();
      return leaf ? `${archiveName} › ${leaf}` : archiveName;
    }
    const drive = drives.find(
      (item) => item.path.toLowerCase() === path.toLowerCase(),
    );
    if (drive) return drive.label || drive.name;
    return basename(path);
  }, [route, path, drives]);

  return (
    <header
      data-titlebar
      data-tauri-drag-region
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        void toggleMaximizeWindow();
      }}
      className="relative flex h-[40px] shrink-0 items-center border-b border-mac-line bg-mac-chrome/85 pl-4 backdrop-blur-2xl"
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none absolute inset-x-0 text-center"
      >
        <div className="mx-auto max-w-[52%] truncate text-[12.5px] font-medium text-mac-text/85">
          {title}
        </div>
      </div>

      <div className="ml-auto flex h-full items-center">
        <CaptionButton label="最小化" onPress={() => void minimizeWindow()}>
          <SFMinus size={14} />
        </CaptionButton>
        <CaptionButton
          label="最大化"
          onPress={() => void toggleMaximizeWindow()}
        >
          <SFSquare size={11} />
        </CaptionButton>
        <CaptionButton
          label="关闭"
          danger
          onPress={() => void closeWindow()}
        >
          <SFXmark size={14} />
        </CaptionButton>
      </div>
    </header>
  );
}
