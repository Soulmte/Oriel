import { useEffect } from "react";
import { useExplorer } from "../store/explorer";
import { ACCENTS, fontStackFor, hexToRgba } from "../lib/appearance";

/**
 * Applies the presentation preferences to the document.
 *
 * Everything is driven by a CSS variable or a data attribute, so components keep
 * using `bg-mac-blue` / `animate-fade-in` and simply follow the setting.
 */
export function useAppearanceEffects(): void {
  const appearance = useExplorer((state) => state.appearance);

  useEffect(() => {
    const root = document.documentElement;
    const accent = ACCENTS[appearance.accent] ?? ACCENTS.blue;
    // A custom colour wins over the preset swatch.
    const color = appearance.customAccent || accent.color;
    const soft = appearance.customAccent
      ? hexToRgba(appearance.customAccent, 0.2)
      : accent.soft;

    root.style.setProperty("--color-mac-blue", color);
    root.style.setProperty("--color-mac-blue-soft", soft);
    // Folder icons follow the accent instead of a fixed Finder blue.
    root.style.setProperty("--folder-tint", color);
    root.style.setProperty("--folder-tint-soft", hexToRgba(color, 0.16));
    // Filled surfaces (selection, primary buttons, progress bars) use this; a
    // solid accent leaves it as `none` and the background colour shows.
    root.style.setProperty(
      "--accent-gradient",
      appearance.accentTo
        ? `linear-gradient(135deg, ${color} 0%, ${appearance.accentTo} 100%)`
        : "none",
    );
  }, [appearance.accent, appearance.customAccent, appearance.accentTo]);

  useEffect(() => {
    // Chromium implements `zoom` on the root element, which scales layout and
    // hit-testing together — exactly what a display scale should do.
    document.documentElement.style.zoom =
      appearance.scale === "100" ? "" : String(Number(appearance.scale) / 100);
  }, [appearance.scale]);

  useEffect(() => {
    document.documentElement.dataset.motion = appearance.reduceMotion
      ? "reduced"
      : "full";
  }, [appearance.reduceMotion]);

  useEffect(() => {
    document.documentElement.dataset.grid = appearance.gridSize;
  }, [appearance.gridSize]);

  useEffect(() => {
    document.documentElement.dataset.glass = appearance.glass;
  }, [appearance.glass]);

  useEffect(() => {
    const stack = fontStackFor(appearance.fontFamily, appearance.customFont);
    const root = document.documentElement;
    if (stack) root.style.setProperty("--font-sans", stack);
    else root.style.removeProperty("--font-sans");
  }, [appearance.fontFamily, appearance.customFont]);
}
