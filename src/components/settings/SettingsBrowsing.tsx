import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { SFListBullet, SFSquareGrid2x2 } from "sf-symbols-lib/dualtone";
import { useExplorer } from "../../store/explorer";
import {
  SEGMENT_CLASS,
  SEGMENT_TRACK,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "./shared";

export function SettingsBrowsing() {
  const view = useExplorer((state) => state.view);
  const setView = useExplorer((state) => state.setView);
  const showHidden = useExplorer((state) => state.showHidden);
  const setShowHidden = useExplorer((state) => state.setShowHidden);
  const startLocation = useExplorer((state) => state.startLocation);
  const setStartLocation = useExplorer((state) => state.setStartLocation);

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
