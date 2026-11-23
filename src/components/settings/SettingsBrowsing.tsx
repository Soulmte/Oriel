import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { SFListBullet, SFSquareGrid2x2 } from "sf-symbols-lib/dualtone";
import { useExplorer } from "../../store/explorer";
import type { ListColumnKey } from "../../store/explorer";
import {
  SEGMENT_CLASS,
  SEGMENT_TRACK,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "./shared";

const LIST_COLUMN_LABELS: Array<{ key: ListColumnKey; label: string }> = [
  { key: "date", label: "修改日期" },
  { key: "size", label: "大小" },
  { key: "kind", label: "种类" },
];

export function SettingsBrowsing() {
  const view = useExplorer((state) => state.view);
  const setView = useExplorer((state) => state.setView);
  const showHidden = useExplorer((state) => state.showHidden);
  const setShowHidden = useExplorer((state) => state.setShowHidden);
  const startLocation = useExplorer((state) => state.startLocation);
  const setStartLocation = useExplorer((state) => state.setStartLocation);
  const showExtensions = useExplorer((state) => state.appearance.showExtensions);
  const setAppearance = useExplorer((state) => state.setAppearance);
  const showThumbnails = useExplorer((state) => state.showThumbnails);
  const setShowThumbnails = useExplorer((state) => state.setShowThumbnails);
  const singleClickOpen = useExplorer((state) => state.singleClickOpen);
  const setSingleClickOpen = useExplorer((state) => state.setSingleClickOpen);
  const sidebarFavorites = useExplorer((state) => state.sidebarFavorites);
  const setSidebarFavorites = useExplorer((state) => state.setSidebarFavorites);
  const listColumns = useExplorer((state) => state.listColumns);
  const setListColumns = useExplorer((state) => state.setListColumns);

  return (
    <>
      <SettingsPageHeader
        title="浏览"
        detail="列表、隐藏项与启动位置的默认行为"
      />

      <SettingsSection title="显示">
        <SettingsRow
          title="显示隐藏文件"
          detail="包括以点开头的文件和 Windows 已知系统项"
        >
          <SettingsSwitch
            label="显示隐藏文件"
            selected={showHidden}
            onChange={setShowHidden}
          />
        </SettingsRow>

        <SettingsRow
          title="显示文件扩展名"
          detail="关掉后只显示 report，而不是 report.docx"
        >
          <SettingsSwitch
            label="显示文件扩展名"
            selected={showExtensions}
            onChange={(value) => setAppearance("showExtensions", value)}
          />
        </SettingsRow>

        <SettingsRow
          title="显示缩略图"
          detail="关掉后只显示文件类型图标，大目录滚动更顺滑"
        >
          <SettingsSwitch
            label="显示缩略图"
            selected={showThumbnails}
            onChange={setShowThumbnails}
          />
        </SettingsRow>

        <SettingsRow title="侧边栏显示「收藏」" detail="个人、桌面、下载等常用位置">
          <SettingsSwitch
            label="侧边栏收藏"
            selected={sidebarFavorites}
            onChange={setSidebarFavorites}
          />
        </SettingsRow>

        <SettingsRow title="默认视图" detail="新窗口和切换视图时使用的布局">
          <ToggleButtonGroup
            aria-label="默认视图"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[view]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (next === "grid" || next === "list") setView(next);
            }}
            size="sm"
            className={SEGMENT_TRACK}
          >
            <ToggleButton id="grid" className={SEGMENT_CLASS}>
              <SFSquareGrid2x2 size={14} />
              图标
            </ToggleButton>
            <ToggleButton id="list" className={SEGMENT_CLASS}>
              <SFListBullet size={14} />
              列表
            </ToggleButton>
          </ToggleButtonGroup>
        </SettingsRow>

        <SettingsRow title="列表显示的列" detail="名称列始终显示">
          <div className="flex items-center gap-4">
            {LIST_COLUMN_LABELS.map(({ key, label }) => {
              const checked = listColumns.includes(key);
              return (
                <label
                  key={key}
                  className="flex cursor-default items-center gap-1.5 text-[12px] text-mac-text"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setListColumns(
                        checked
                          ? listColumns.filter((item) => item !== key)
                          : [...listColumns, key],
                      )
                    }
                    className="size-3.5 shrink-0 accent-[#0a84ff]"
                  />
                  {label}
                </label>
              );
            })}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="操作">
        <SettingsRow
          title="单击打开"
          detail="点一下就直接打开项目，按住 Ctrl / Shift 仍可多选"
        >
          <SettingsSwitch
            label="单击打开"
            selected={singleClickOpen}
            onChange={setSingleClickOpen}
          />
        </SettingsRow>

        <SettingsRow title="启动位置" detail="下次打开窗口时先显示哪个位置">
          <ToggleButtonGroup
            aria-label="启动位置"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[startLocation]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (next === "last" || next === "home" || next === "start") {
                setStartLocation(next);
              }
            }}
            size="sm"
            className={SEGMENT_TRACK}
          >
            <ToggleButton id="last" className={SEGMENT_CLASS}>
              上次位置
            </ToggleButton>
            <ToggleButton id="start" className={SEGMENT_CLASS}>
              首页
            </ToggleButton>
            <ToggleButton id="home" className={SEGMENT_CLASS}>
              个人文件夹
            </ToggleButton>
          </ToggleButtonGroup>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
