import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";
import { Check, ChevronDown, Search } from "lucide-react";
import { api } from "../../lib/api";

/**
 * Font family picker backed by the machine's installed fonts.
 *
 * The list is fetched from the REST service (`/system/fonts`), cached for the
 * session, and every row renders in its own typeface so the choice is visual
 * rather than a name in a dropdown.
 */

let fontCache: string[] | null = null;
let fontRequest: Promise<string[]> | null = null;

function loadFonts(): Promise<string[]> {
  if (fontCache) return Promise.resolve(fontCache);
  if (!fontRequest) {
    fontRequest = api
      .fonts()
      .then((response) => {
        fontCache = response.fonts;
        return response.fonts;
      })
      .catch(() => [] as string[])
      .finally(() => {
        fontRequest = null;
      });
  }
  return fontRequest;
}

const PANEL_WIDTH = 300;
const PANEL_MAX_HEIGHT = 380;
const MAX_ROWS = 160;

export function FontPicker({
  family,
  label,
  onChange,
}: {
  /** Currently selected family name (empty when a preset is active). */
  family: string;
  /** What the button shows. */
  label: string;
  onChange: (family: string) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [fonts, setFonts] = useState<string[]>(fontCache ?? []);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0, height: PANEL_MAX_HEIGHT });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void loadFonts().then((list) => {
      if (alive) setFonts(list);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const node = button.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8),
    );
    // Shrink to whatever room is left instead of running off the screen, and
    // open upwards when there is clearly more space above the button.
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
    const height = Math.max(
      180,
      Math.min(PANEL_MAX_HEIGHT, (openUp ? spaceAbove : spaceBelow) - 6),
    );
    const top = openUp
      ? Math.max(8, rect.top - height - 6)
      : rect.bottom + 6;
    setPosition({ left, top, height });
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (button.current?.contains(target)) return;
      if (panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // The panel is positioned once in viewport coordinates; if the page moves
    // under it (scroll, resize) it would float away from the button, so close
    // it — the same behaviour as a native dropdown.
    const onScroll = (event: Event) => {
      if (panel.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? fonts.filter((name) => name.toLowerCase().includes(needle))
      : fonts;
    return list.slice(0, MAX_ROWS);
  }, [fonts, query]);

  const choose = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 min-w-[150px] max-w-[220px] items-center gap-1.5 rounded-lg border border-mac-line bg-mac-chrome px-2 text-[12px] text-mac-text outline-none transition-colors hover:border-mac-blue/50 focus-visible:ring-2 focus-visible:ring-mac-blue/60"
      >
        <span
          className="min-w-0 flex-1 truncate text-left"
          style={{ fontFamily: family ? `"${family}"` : undefined }}
        >
          {label}
        </span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </button>

      {open &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label="选择字体"
            style={{
              left: position.left,
              top: position.top,
              width: PANEL_WIDTH,
              maxHeight: position.height,
            }}
            className="fixed z-[130] flex flex-col overflow-hidden rounded-[10px] border border-black/10 bg-[#fbfbfd]/95 shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur-2xl dark:border-white/10 dark:bg-[#2c2c2e]/95"
          >
            <div className="flex items-center gap-2 border-b border-mac-line px-2.5 py-2">
              <Search className="size-3.5 shrink-0 text-mac-muted" />
              <input
                ref={input}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`搜索 ${fonts.length} 款已安装字体`}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-mac-text outline-none placeholder:text-mac-muted/70"
              />
            </div>

            <div
              role="listbox"
              aria-label="字体列表"
              className="min-h-0 flex-1 overflow-y-auto p-1"
            >
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-[12px] text-mac-muted">
                  {fonts.length === 0 ? "正在读取系统字体…" : "没有匹配的字体"}
                </p>
              ) : (
                filtered.map((name) => {
                  const selected = name === family;
                  return (
                    <button
                      key={name}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => choose(name)}
                      className={clsx(
                        "flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] transition-colors",
                        selected
                          ? "bg-mac-blue/15 text-mac-text"
                          : "text-mac-text hover:bg-black/[0.05] dark:hover:bg-white/[0.08]",
                      )}
                    >
                      <span
                        className="min-w-0 flex-1 truncate"
                        style={{ fontFamily: `"${name}", sans-serif` }}
                      >
                        {name}
                      </span>
                      <span className="shrink-0 text-[11px] opacity-50">
                        中文示例
                      </span>
                      {selected && <Check className="size-3.5 shrink-0" />}
                    </button>
                  );
                })
              )}
            </div>

            <div className="flex items-center justify-between border-t border-mac-line px-2.5 py-1.5 text-[11px] text-mac-muted">
              <span>共 {fonts.length} 款</span>
              {filtered.length < fonts.length && (
                <span>继续输入以缩小范围</span>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
