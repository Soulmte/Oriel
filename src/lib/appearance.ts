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
  /** Hex chosen from the colour picker; overrides `accent` when set. */
  customAccent: string;
  /** Second stop of an accent gradient; empty means a solid accent. */
  accentTo: string;
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
  customAccent: "",
  accentTo: "",
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

/** `#0a84ff` → `rgba(10, 132, 255, alpha)`; used for the soft tints. */
export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return `rgba(10, 132, 255, ${alpha})`;
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/** Curated solid colours for the accent picker. */
export const ACCENT_SWATCHES: string[] = [
  "#0a84ff",
  "#4f7cff",
  "#7d5cff",
  "#b45cff",
  "#ff3d7f",
  "#ff5a5f",
  "#ff7a45",
  "#ff9f0a",
  "#ffc107",
  "#30c85a",
  "#2ec4a6",
  "#14b8a6",
  "#00b8d4",
  "#0ea5e9",
  "#64748b",
  "#8e8e93",
];

/** Two-stop accents; the first stop becomes the UI colour, the second only the gradient. */
export const ACCENT_GRADIENTS: Array<{ label: string; from: string; to: string }> = [
  { label: "极光", from: "#0a84ff", to: "#7d5cff" },
  { label: "日落", from: "#ff7a45", to: "#ff3d7f" },
  { label: "薄荷", from: "#30c85a", to: "#0ea5e9" },
  { label: "霓虹", from: "#b45cff", to: "#ff9f0a" },
];

/** `hsl` → `#rrggbb`, for the hue slider. */
export function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Hue + lightness of a hex colour, for seeding the slider. */
export function hexToHsl(hex: string): { hue: number; lightness: number } {
  const value = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return { hue: 211, lightness: 52 };
  const r = Number.parseInt(value.slice(0, 2), 16) / 255;
  const g = Number.parseInt(value.slice(2, 4), 16) / 255;
  const b = Number.parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  hue = Math.round(hue * 60);
  if (hue < 0) hue += 360;
  const lightness = Math.round(((max + min) / 2) * 100);
  return { hue, lightness };
}

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
      customAccent:
        typeof parsed.customAccent === "string" && /^#[0-9a-f]{6}$/i.test(parsed.customAccent)
          ? parsed.customAccent
          : "",
      accentTo:
        typeof parsed.accentTo === "string" && /^#[0-9a-f]{6}$/i.test(parsed.accentTo)
          ? parsed.accentTo
          : "",
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
