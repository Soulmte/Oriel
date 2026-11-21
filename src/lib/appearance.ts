/**
 * Appearance preferences that are pure presentation: the accent colour, the UI
 * scale, motion and the grid metrics. Everything here is applied through CSS
 * variables / attributes so no component needs to know about the settings.
 */

export type AccentKey = "blue" | "purple" | "pink" | "orange" | "green" | "graphite";
export type UiScale = "90" | "100" | "110" | "125";
export type GridSize = "sm" | "md" | "lg";
export type ListDensity = "compact" | "comfortable" | "spacious";
export type GlassLevel = "off" | "normal" | "strong";
export type FontFamilyKey = "system" | "serif" | "mono" | "custom";

export interface AppearancePrefs {
  accent: AccentKey;
  scale: UiScale;
  /** Disable transitions and animations (accessibility / low-end machines). */
  reduceMotion: boolean;
  gridSize: GridSize;
  /** Show `report.docx` instead of `report` in the grid and list. */
  showExtensions: boolean;
  density: ListDensity;
  glass: GlassLevel;
  fontFamily: FontFamilyKey;
  /** Font family used when `fontFamily === "custom"` (e.g. "微软雅黑"). */
  customFont: string;
}

export const APPEARANCE_STORAGE_KEY = "oriel:pref-appearance";

export const DEFAULT_APPEARANCE: AppearancePrefs = {
  accent: "blue",
  scale: "100",
  reduceMotion: false,
  gridSize: "md",
  showExtensions: true,
  density: "comfortable",
  glass: "normal",
  fontFamily: "system",
  customFont: "",
};

export const DENSITY_LABELS: Record<ListDensity, string> = {
  compact: "紧凑",
  comfortable: "标准",
  spacious: "宽松",
};

/** List row height per density; the virtualizer uses this number. */
export const DENSITY_ROW_HEIGHT: Record<ListDensity, number> = {
  compact: 24,
  comfortable: 28,
  spacious: 34,
};

export const GLASS_LABELS: Record<GlassLevel, string> = {
  off: "关闭",
  normal: "标准",
  strong: "更强",
};

export const FONT_LABELS: Record<FontFamilyKey, string> = {
  system: "系统默认",
  serif: "衬线（宋体）",
  mono: "等宽",
  custom: "自定义",
};

/** Everything after the chosen family, so CJK text still has a fallback. */
export const FONT_FALLBACK = '"PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif';

export function fontStackFor(
  fontFamily: FontFamilyKey,
  customFont: string,
): string {
  if (fontFamily !== "custom") return FONT_STACKS[fontFamily];
  if (!customFont.trim()) return "";
  return `"${customFont.trim()}", ${FONT_FALLBACK}`;
}

/** Applied to `--font-sans`; empty means "keep the theme default". */
export const FONT_STACKS: Record<FontFamilyKey, string> = {
  system: "",
  serif: '"Songti SC", "SimSun", "Noto Serif CJK SC", Georgia, serif',
  mono: '"JetBrains Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  custom: "",
};

export const ACCENTS: Record<
  AccentKey,
  { label: string; color: string; soft: string; strong: string }
> = {
  blue: { label: "蓝色", color: "#0a84ff", soft: "rgba(10, 132, 255, 0.20)", strong: "#0a6fe0" },
  purple: { label: "紫色", color: "#7d5cff", soft: "rgba(125, 92, 255, 0.20)", strong: "#6647e6" },
  pink: { label: "粉色", color: "#ff3d7f", soft: "rgba(255, 61, 127, 0.20)", strong: "#e62b6b" },
  orange: { label: "橙色", color: "#ff9f0a", soft: "rgba(255, 159, 10, 0.20)", strong: "#e08a00" },
  green: { label: "绿色", color: "#30c85a", soft: "rgba(48, 200, 90, 0.20)", strong: "#24a948" },
  graphite: { label: "石墨", color: "#8e8e93", soft: "rgba(142, 142, 147, 0.22)", strong: "#6f6f74" },
};

export const SCALES: Array<{ value: UiScale; label: string }> = [
  { value: "90", label: "90%" },
  { value: "100", label: "100%" },
  { value: "110", label: "110%" },
  { value: "125", label: "125%" },
];

/** Grid metrics per icon size; the virtualizer needs the row height. */
export const GRID_METRICS: Record<
  GridSize,
  { itemWidth: number; itemHeight: number; iconSize: number; labelWidth: number }
> = {
  sm: { itemWidth: 88, itemHeight: 86, iconSize: 40, labelWidth: 82 },
  md: { itemWidth: 104, itemHeight: 100, iconSize: 52, labelWidth: 96 },
  lg: { itemWidth: 128, itemHeight: 124, iconSize: 68, labelWidth: 118 },
};

export const GRID_SIZE_LABELS: Record<GridSize, string> = {
  sm: "小",
  md: "中",
  lg: "大",
};

const SCALE_VALUES: UiScale[] = ["90", "100", "110", "125"];

export function readAppearance(): AppearancePrefs {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const parsed = JSON.parse(raw) as Partial<AppearancePrefs>;
    const accent =
      typeof parsed.accent === "string" && parsed.accent in ACCENTS
        ? (parsed.accent as AccentKey)
        : DEFAULT_APPEARANCE.accent;
    const scale = SCALE_VALUES.includes(parsed.scale as UiScale)
      ? (parsed.scale as UiScale)
      : DEFAULT_APPEARANCE.scale;
    const gridSize =
      parsed.gridSize === "sm" || parsed.gridSize === "lg" || parsed.gridSize === "md"
        ? parsed.gridSize
        : DEFAULT_APPEARANCE.gridSize;
    const density =
      parsed.density === "compact" || parsed.density === "spacious"
        ? parsed.density
        : DEFAULT_APPEARANCE.density;
    const glass =
      parsed.glass === "off" || parsed.glass === "strong"
        ? parsed.glass
        : DEFAULT_APPEARANCE.glass;
    const fontFamily =
      parsed.fontFamily === "serif" ||
      parsed.fontFamily === "mono" ||
      parsed.fontFamily === "custom"
        ? parsed.fontFamily
        : DEFAULT_APPEARANCE.fontFamily;

    return {
      accent,
      scale,
      gridSize,
      density,
      glass,
      fontFamily,
      // Older builds stored a full stack; keep just the family name.
      customFont:
        typeof parsed.customFont === "string"
          ? parsed.customFont.replace(/^"([^"]+)".*$/, "$1").split(",")[0].replace(/"/g, "").trim()
          : "",

      reduceMotion:
        typeof parsed.reduceMotion === "boolean"
          ? parsed.reduceMotion
          : DEFAULT_APPEARANCE.reduceMotion,
      showExtensions:
        typeof parsed.showExtensions === "boolean"
          ? parsed.showExtensions
          : DEFAULT_APPEARANCE.showExtensions,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function writeAppearance(prefs: AppearancePrefs): void {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Storage disabled: preferences just will not persist.
  }
}
