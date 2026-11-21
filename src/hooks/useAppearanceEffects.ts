import { useEffect } from "react";
import { useExplorer } from "../store/explorer";
import { ACCENTS, fontStackFor } from "../lib/appearance";

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

    root.style.setProperty("--color-mac-blue", accent.color);
    root.style.setProperty("--color-mac-blue-soft", accent.soft);
  }, [appearance.accent]);

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
