import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { useExplorer } from "../../store/explorer";
import {
  ACCENTS,
  ACCENT_GRADIENTS,
  ACCENT_SWATCHES,
  hexToHsl,
  hexToRgba,
  hslToHex,
} from "../../lib/appearance";

/** A pleasant second stop: same colour, shifted hue and a touch lighter. */
function gradientEnd(hex: string): string {
  const { hue, lightness } = hexToHsl(hex);
  return hslToHex((hue + 42) % 360, 78, Math.min(72, lightness + 10));
}

/**
 * Accent picker: a curated palette, four ready-made gradients and a hue slider
 * for anything else. Drawn in-app because the native colour dialog is a
 * separate Windows window that ignores the app's styling.
 */
export function AccentPicker() {
  const appearance = useExplorer((state) => state.appearance);
  const setAppearance = useExplorer((state) => state.setAppearance);

  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // The settings page scrolls inside an overflow-hidden card; a scrolled
    // panel would detach from its trigger, so closing is kinder.
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    if (next && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const width = 272;
      setAnchor({
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        top: rect.bottom + 8,
      });
    }
    setOpen(next);
  };

  const color = appearance.customAccent || ACCENTS[appearance.accent].color;
  const gradient = appearance.accentTo;
  const { hue, lightness } = hexToHsl(color);

  const chooseSolid = (hex: string) => {
    setAppearance("customAccent", hex);
    // Keep a gradient going by moving its end along with the new colour.
    if (gradient) setAppearance("accentTo", gradientEnd(hex));
    else setAppearance("accentTo", "");
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="强调色"
        aria-expanded={open}
        onClick={toggle}
        className="grid size-7 place-items-center rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-mac-blue/60"
        style={{
          boxShadow: `0 0 0 2px var(--color-mac-surface), 0 0 0 3.5px ${hexToRgba(color, 0.85)}`,
        }}
      >
        <span
          className="rounded-full"
          style={{
            width: 18,
            height: 18,
            background: gradient ? `linear-gradient(135deg, ${color}, ${gradient})` : color,
          }}
        />
      </button>

      {open && anchor && (
        <div
          style={{ position: "fixed", left: anchor.left, top: anchor.top }}
          className="z-[300] w-[272px] rounded-[12px] border border-mac-line bg-mac-surface p-3 shadow-[0_18px_44px_rgba(0,0,0,0.22)]"
        >
          <p className="mb-2 text-[11px] font-medium text-mac-muted">纯色</p>
          <div className="grid grid-cols-8 gap-1.5">
            {ACCENT_SWATCHES.map((hex) => {
              const selected = !gradient && color.toLowerCase() === hex.toLowerCase();
              return (
                <button
                  key={hex}
                  type="button"
                  title={hex}
                  aria-label={hex}
                  onClick={() => chooseSolid(hex)}
                  className={clsx(
                    "size-6 rounded-full outline-none transition-transform hover:scale-110",
                    selected && "ring-2 ring-offset-2 ring-offset-mac-surface",
                  )}
                  style={{
                    backgroundColor: hex,
                    ...(selected ? { boxShadow: `0 0 0 2px ${hex}` } : null),
                  }}
                />
              );
            })}
          </div>

          <p className="mb-2 mt-3 text-[11px] font-medium text-mac-muted">渐变</p>
          <div className="flex items-center gap-1.5">
            {ACCENT_GRADIENTS.map((preset) => {
              const selected =
                gradient?.toLowerCase() === preset.to.toLowerCase() &&
                color.toLowerCase() === preset.from.toLowerCase();
              return (
                <button
                  key={preset.label}
                  type="button"
                  title={preset.label}
                  aria-label={preset.label}
                  onClick={() => {
                    setAppearance("customAccent", preset.from);
                    setAppearance("accentTo", preset.to);
                  }}
                  className={clsx(
                    "size-6 rounded-full outline-none transition-transform hover:scale-110",
                    selected && "ring-2 ring-offset-2 ring-offset-mac-surface",
                  )}
                  style={{
                    background: `linear-gradient(135deg, ${preset.from}, ${preset.to})`,
                    ...(selected ? { boxShadow: `0 0 0 2px ${preset.from}` } : null),
                  }}
                />
              );
            })}
            <button
              type="button"
              onClick={() =>
                setAppearance("accentTo", gradient ? "" : gradientEnd(color))
              }
              className={clsx(
                "ml-auto h-6 rounded-[6px] px-2 text-[11px] transition-colors",
                gradient
                  ? "bg-mac-blue/12 text-mac-blue"
                  : "bg-black/[0.06] text-mac-muted hover:text-mac-text dark:bg-white/[0.09]",
              )}
            >
              {gradient ? "取消渐变" : "自定义渐变"}
            </button>
          </div>

          <p className="mb-2 mt-3 text-[11px] font-medium text-mac-muted">自定义</p>
          <div className="flex flex-col gap-2">
            <input
              type="range"
              min={0}
              max={359}
              value={hue}
              aria-label="色相"
              onChange={(event) =>
                chooseSolid(hslToHex(Number(event.target.value), 78, lightness))
              }
              className="h-2.5 w-full cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow"
              style={{
                background:
                  "linear-gradient(90deg, #ff3d3d, #ffbe3d, #3dff6e, #3dd8ff, #4f6bff, #b93dff, #ff3d3d)",
              }}
            />
            <input
              type="range"
              min={28}
              max={78}
              value={lightness}
              aria-label="明度"
              onChange={(event) =>
                chooseSolid(hslToHex(hue, 78, Number(event.target.value)))
              }
              className="h-2.5 w-full cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:shadow"
              style={{
                background: `linear-gradient(90deg, #1b1b1f, ${hslToHex(hue, 78, 52)}, #ffffff)`,
              }}
            />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span
              className="size-6 shrink-0 rounded-full"
              style={{ background: gradient ? `linear-gradient(135deg, ${color}, ${gradient})` : color }}
            />
            <input
              type="text"
              value={color}
              aria-label="色值"
              spellCheck={false}
              onChange={(event) => {
                const next = event.target.value.trim();
                if (/^#[0-9a-f]{6}$/i.test(next)) chooseSolid(next.toLowerCase());
              }}
              className="h-6 w-full rounded-[5px] border border-mac-line bg-black/[0.03] px-2 font-mono text-[11px] text-mac-text outline-none focus:border-mac-blue dark:bg-white/[0.05]"
            />
          </div>
        </div>
      )}
    </div>
  );
}
