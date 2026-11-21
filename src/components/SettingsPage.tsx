import { useEffect, useState } from "react";
import { clsx } from "clsx";
import {
  SFChevronLeft,
  SFDesktopcomputer,
  SFExternaldriveFill,
  SFInfoCircle,
  SFLine3Horizontal,
  SFListBullet,
} from "sf-symbols-lib/dualtone";
import { useExplorer } from "../store/explorer";
import { SettingsAppearance } from "./settings/SettingsAppearance";
import { SettingsBrowsing } from "./settings/SettingsBrowsing";
import { SettingsContextMenu } from "./settings/SettingsContextMenu";
import { SettingsService } from "./settings/SettingsService";
import { SettingsAbout } from "./settings/SettingsAbout";

type SectionId = "appearance" | "browsing" | "menu" | "service" | "about";

const SECTIONS: Array<{
  id: SectionId;
  label: string;
  Icon: typeof SFListBullet;
}> = [
  { id: "appearance", label: "外观", Icon: SFDesktopcomputer },
  { id: "browsing", label: "浏览", Icon: SFListBullet },
  { id: "menu", label: "右键菜单", Icon: SFLine3Horizontal },
  { id: "service", label: "本地服务", Icon: SFExternaldriveFill },
  { id: "about", label: "关于", Icon: SFInfoCircle },
];

const SECTION_KEY = "oriel:pref-settings-section";

function readSection(): SectionId {
  try {
    const raw = localStorage.getItem(SECTION_KEY);
    if (raw && SECTIONS.some((section) => section.id === raw)) {
      return raw as SectionId;
    }
  } catch {
    // Ignore: fall back to the first page.
  }
  return "appearance";
}

export function SettingsPage() {
  const closeSettings = useExplorer((state) => state.closeSettings);
  const [section, setSection] = useState<SectionId>(readSection);

  useEffect(() => {
    try {
      localStorage.setItem(SECTION_KEY, section);
    } catch {
      // Persisting the page choice is best effort.
    }
  }, [section]);

  return (
    <div className="flex min-h-0 flex-1 bg-mac-surface">
      <nav
        aria-label="设置分类"
        className="flex w-[188px] shrink-0 flex-col gap-0.5 border-r border-mac-line px-2.5 py-3"
      >
        <button
          type="button"
          onClick={closeSettings}
          className="mb-2 flex items-center gap-1.5 rounded-[6px] px-2 py-1.5 text-[12px] text-mac-muted transition-colors hover:bg-black/[0.045] hover:text-mac-text dark:hover:bg-white/[0.06]"
        >
          <SFChevronLeft size={13} />
          返回文件
        </button>

        {SECTIONS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
            className={clsx(
              "flex h-[32px] items-center gap-2.5 rounded-[7px] px-2 text-left text-[13px] transition-colors",
              "outline-none focus-visible:ring-2 focus-visible:ring-mac-blue/60",
              section === id
                ? "bg-black/[0.085] font-medium text-mac-text dark:bg-white/[0.13]"
                : "text-mac-text hover:bg-black/[0.045] dark:hover:bg-white/[0.06]",
            )}
          >
            <Icon size={15} className="shrink-0 text-mac-muted" />
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[980px] px-9 pb-16 pt-7">
          {section === "appearance" && <SettingsAppearance />}
          {section === "browsing" && <SettingsBrowsing />}
          {section === "menu" && <SettingsContextMenu />}
          {section === "service" && <SettingsService />}
          {section === "about" && <SettingsAbout />}
        </div>
      </div>
    </div>
  );
}
