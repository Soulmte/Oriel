import { Button, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import {
  SFDesktopcomputer,
  SFMoonFill,
  SFSunMax,
} from "sf-symbols-lib/dualtone";
import { useExplorer } from "../../store/explorer";
import { useAppTheme } from "../ThemeProvider";
import {
  ACCENTS,
  DENSITY_LABELS,
  DENSITY_ROW_HEIGHT,
  FONT_LABELS,
  fontStackFor,
  GLASS_LABELS,
  GRID_SIZE_LABELS,
  GRID_METRICS,
  SCALES,
} from "../../lib/appearance";
import type {
  AccentKey,
  GlassLevel,
  GridSize,
  ListDensity,
  UiScale,
} from "../../lib/appearance";
import { SFArrowCounterclockwise } from "sf-symbols-lib/dualtone";
import { FontPicker } from "./FontPicker";
import {
  SEGMENT_CLASS,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "./shared";

const SCALE_KEYS = SCALES.map((item) => item.value);
const GRID_KEYS: GridSize[] = ["sm", "md", "lg"];
const DENSITY_KEYS: ListDensity[] = ["compact", "comfortable", "spacious"];
const GLASS_KEYS: GlassLevel[] = ["off", "normal", "strong"];

export function SettingsAppearance() {
  const { theme, setTheme } = useAppTheme();
  const appearance = useExplorer((state) => state.appearance);
  const setAppearance = useExplorer((state) => state.setAppearance);
  const resetLayout = useExplorer((state) => state.resetLayout);
  const forgetFolderViews = useExplorer((state) => state.forgetFolderViews);

  return (
    <>
      <SettingsPageHeader
        title="外观"
        detail="主题、强调色、显示缩放与网格密度，改动立即生效并记住"
      />

      <SettingsSection title="主题">
        <SettingsRow
          title="外观模式"
          detail="跟随系统会随 Windows 的浅色或深色外观切换"
        >
          <ToggleButtonGroup
            aria-label="主题"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[theme]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (typeof next === "string") setTheme(next);
            }}
            size="sm"
            className="rounded-lg border border-mac-line bg-mac-chrome p-0.5"
          >
            <ToggleButton id="light" className={SEGMENT_CLASS}>
              <SFSunMax size={14} />
              浅色
            </ToggleButton>
            <ToggleButton id="dark" className={SEGMENT_CLASS}>
              <SFMoonFill size={14} />
              深色
            </ToggleButton>
            <ToggleButton id="system" className={SEGMENT_CLASS}>
              <SFDesktopcomputer size={14} />
              跟随系统
            </ToggleButton>
          </ToggleButtonGroup>
        </SettingsRow>

        <SettingsRow
          title="强调色"
          detail="选中项、按钮与进度条的颜色，文件夹和文件类型图标保持各自的配色"
        >
          <div className="flex items-center gap-1.5">
            {(Object.keys(ACCENTS) as AccentKey[]).map((key) => {
              const accent = ACCENTS[key];
              const selected = appearance.accent === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={accent.label}
                  aria-pressed={selected}
                  title={accent.label}
                  onClick={() => setAppearance("accent", key)}
                  className="grid size-7 place-items-center rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-mac-blue/60"
                  style={{
                    boxShadow: selected
                      ? `0 0 0 2px var(--color-mac-surface), 0 0 0 3.5px ${accent.color}`
                      : undefined,
                  }}
                >
                  <span
                    className="size-4.5 rounded-full"
                    style={{ backgroundColor: accent.color, width: 18, height: 18 }}
                  />
                </button>
              );
            })}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="显示">
        <SettingsRow
          title="界面缩放"
          detail="整体放大或缩小以便在小屏或高分屏上阅读，100% 为默认"
        >
          <ToggleButtonGroup
            aria-label="界面缩放"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[appearance.scale]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (typeof next === "string" && SCALE_KEYS.includes(next as UiScale)) {
                setAppearance("scale", next as UiScale);
              }
            }}
            size="sm"
            className="rounded-lg border border-mac-line bg-mac-chrome p-0.5"
          >
            {SCALES.map((scale) => (
              <ToggleButton key={scale.value} id={scale.value} className={SEGMENT_CLASS}>
                {scale.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </SettingsRow>

        <SettingsRow
          title="网格图标大小"
          detail={`图标视图的格子尺寸，当前 ${GRID_METRICS[appearance.gridSize].itemWidth}×${GRID_METRICS[appearance.gridSize].itemHeight}`}
        >
          <ToggleButtonGroup
            aria-label="网格图标大小"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[appearance.gridSize]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (next === "sm" || next === "md" || next === "lg") {
                setAppearance("gridSize", next);
              }
            }}
            size="sm"
            className="rounded-lg border border-mac-line bg-mac-chrome p-0.5"
          >
            {GRID_KEYS.map((key) => (
              <ToggleButton key={key} id={key} className={SEGMENT_CLASS}>
                {GRID_SIZE_LABELS[key]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </SettingsRow>
        <SettingsRow
          title="列表密度"
          detail={`列表视图的行高，当前 ${DENSITY_ROW_HEIGHT[appearance.density]}px`}
        >
          <ToggleButtonGroup
            aria-label="列表密度"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[appearance.density]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (next === "compact" || next === "comfortable" || next === "spacious") {
                setAppearance("density", next);
              }
            }}
            size="sm"
            className="rounded-lg border border-mac-line bg-mac-chrome p-0.5"
          >
            {DENSITY_KEYS.map((key) => (
              <ToggleButton key={key} id={key} className={SEGMENT_CLASS}>
                {DENSITY_LABELS[key]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </SettingsRow>

        <SettingsRow
          title="字体"
          detail="从本机已安装的字体中选择；预设项之外的名字会带上中文回退字体"
        >
          <div className="flex items-center gap-2">
            <span
              className="hidden text-[13px] text-mac-muted sm:inline"
              style={{
                fontFamily:
                  fontStackFor(appearance.fontFamily, appearance.customFont) ||
                  undefined,
              }}
            >
              中文示例 Aa 123
            </span>
            <FontPicker
              family={
                appearance.fontFamily === "custom" ? appearance.customFont : ""
              }
              label={
                appearance.fontFamily === "custom" && appearance.customFont
                  ? appearance.customFont
                  : FONT_LABELS[appearance.fontFamily]
              }
              onChange={(family) => {
                setAppearance("customFont", family);
                setAppearance("fontFamily", "custom");
              }}
            />
            {appearance.fontFamily !== "system" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-[11.5px] text-mac-muted"
                onPress={() => setAppearance("fontFamily", "system")}
              >
                默认
              </Button>
            )}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="字体预设">
        <SettingsRow
          title="预设字体栈"
          detail="系统默认使用 SF Pro / Segoe UI / 苹方 的优先栈"
        >
          <ToggleButtonGroup
            aria-label="字体预设"
            selectionMode="single"
            selectedKeys={
              appearance.fontFamily === "custom" ? [] : [appearance.fontFamily]
            }
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (next === "system" || next === "serif" || next === "mono") {
                setAppearance("fontFamily", next);
              }
            }}
            size="sm"
            className="rounded-lg border border-mac-line bg-mac-chrome p-0.5"
          >
            <ToggleButton id="system" className={SEGMENT_CLASS}>
              系统默认
            </ToggleButton>
            <ToggleButton id="serif" className={SEGMENT_CLASS}>
              衬线
            </ToggleButton>
            <ToggleButton id="mono" className={SEGMENT_CLASS}>
              等宽
            </ToggleButton>
          </ToggleButtonGroup>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="细节">
        <SettingsRow
          title="显示文件扩展名"
          detail="关闭后 `报告.docx` 显示为 `报告`，重命名时仍会带上扩展名"
        >
          <SettingsSwitch
            label="显示文件扩展名"
            selected={appearance.showExtensions}
            onChange={(value) => setAppearance("showExtensions", value)}
          />
        </SettingsRow>

        <SettingsRow
          title="动态效果"
          detail="关闭所有过渡与淡入动画，可减少视觉干扰与低配机器上的合成开销"
        >
          <SettingsSwitch
            label="动态效果"
            selected={!appearance.reduceMotion}
            onChange={(value) => setAppearance("reduceMotion", !value)}
          />
        </SettingsRow>

        <SettingsRow
          title="毛玻璃"
          detail="标题栏、侧栏与弹出菜单的背景模糊；关闭后改为实色，低端 GPU 更顺"
        >
          <ToggleButtonGroup
            aria-label="毛玻璃"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[appearance.glass]}
            onSelectionChange={(keys) => {
              const next = Array.from(keys)[0];
              if (next === "off" || next === "normal" || next === "strong") {
                setAppearance("glass", next);
              }
            }}
            size="sm"
            className="rounded-lg border border-mac-line bg-mac-chrome p-0.5"
          >
            {GLASS_KEYS.map((key) => (
              <ToggleButton key={key} id={key} className={SEGMENT_CLASS}>
                {GLASS_LABELS[key]}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="布局">
        <SettingsRow
          title="重置布局"
          detail="侧栏与预览面板恢复默认宽度，预览面板重新打开"
        >
          <Button size="sm" variant="secondary" onPress={resetLayout}>
            <SFArrowCounterclockwise size={14} />
            重置
          </Button>
        </SettingsRow>
        <SettingsRow
          title="视图记忆"
          detail="每个文件夹记住自己的视图、排序、分组与滚动位置，可一键清除"
        >
          <Button size="sm" variant="ghost" onPress={forgetFolderViews}>
            清除记忆
          </Button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
