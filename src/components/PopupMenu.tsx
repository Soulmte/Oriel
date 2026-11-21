import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { clsx } from "clsx";
import { Check, ChevronRight } from "lucide-react";

export interface MenuItem {
  id: string;
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  /** Native tooltip, e.g. why a shell verb cannot be expanded inline. */
  title?: string;
  separator?: boolean;
  /** Nested entries (shell submenus such as 7-Zip or 发送到). */
  children?: MenuItem[];
  onSelect?: () => void;
}

/** Shared shell of the menu box, also used by the settings preview. */
export const MENU_SURFACE_CLASS =
  "rounded-[10px] border border-black/10 bg-[#fbfbfd]/95 p-1 shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur-2xl dark:border-white/10 dark:bg-[#2c2c2e]/95";

const SUBMENU_WIDTH = 220;
const VIEWPORT_PADDING = 8;
/** Grace period so a diagonal mouse path does not close the flyout. */
const CLOSE_DELAY = 140;

/**
 * One menu row (`preview` renders the same look without hover feedback).
 * Rows with `children` own a nested `MenuSurface`, so hovering a *child* row
 * cannot clear the parent's open state (that was closing the flyout on hover).
 */
export function MenuItemRow({
  item,
  index,
  preview = false,
  onSelect,
  onOpenSubmenu,
  open = false,
  depth = 0,
}: {
  item: MenuItem;
  index: number;
  preview?: boolean;
  onSelect?: () => void;
  onOpenSubmenu?: (id: string | null) => void;
  open?: boolean;
  depth?: number;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const flyout = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [box, setBox] = useState<{ left: number; top: number; maxHeight: number } | null>(
    null,
  );
  const submenu = item.children && item.children.length > 0;

  /**
   * The flyout is portalled to <body> so a scrolling parent menu cannot clip it.
   * Position comes from the row's rect, clamped to the viewport on every edge.
   */
  useLayoutEffect(() => {
    if (!open || !submenu) {
      setBox(null);
      return;
    }
    const row = wrapper.current;
    const panel = flyout.current;
    if (!row) return;

    const rect = row.getBoundingClientRect();
    const width = panel?.offsetWidth || SUBMENU_WIDTH;
    const maxHeight = window.innerHeight - VIEWPORT_PADDING * 2;
    const height = Math.min(panel?.scrollHeight ?? 0, maxHeight);

    const flip = rect.right + width > window.innerWidth - VIEWPORT_PADDING;
    const left = flip
      ? Math.max(VIEWPORT_PADDING, rect.left - width + 8)
      : Math.min(rect.right - 8, window.innerWidth - width - VIEWPORT_PADDING);

    const top = Math.max(
      VIEWPORT_PADDING,
      Math.min(rect.top - 5, window.innerHeight - VIEWPORT_PADDING - height),
    );

    setBox({ left, top, maxHeight });
  }, [open, submenu, item.children]);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      onOpenSubmenu?.(null);
    }, CLOSE_DELAY);
  };

  useEffect(() => () => cancelClose(), []);

  if (item.separator) {
    return (
      <div
        className="mx-1 my-1 h-px bg-black/[0.08] dark:bg-white/10"
        aria-hidden="true"
        data-index={index}
      />
    );
  }

  const row = (
    <button
      type="button"
      role="menuitem"
      aria-haspopup={submenu ? "menu" : undefined}
      aria-expanded={submenu ? open : undefined}
      tabIndex={preview ? -1 : undefined}
      title={item.title}
      disabled={item.disabled}
      onMouseEnter={() => {
        cancelClose();
        onOpenSubmenu?.(submenu ? item.id : null);
      }}
      onClick={
        preview
          ? submenu
            ? () => onOpenSubmenu?.(open ? null : item.id)
            : undefined
          : () => {
              if (item.disabled) return;
              if (submenu) {
                onOpenSubmenu?.(open ? null : item.id);
                return;
              }
              item.onSelect?.();
              onSelect?.();
            }
      }
      className={clsx(
        "flex w-full items-center gap-2 rounded-[5px] px-2 py-[5px] text-left text-[13px] leading-4 outline-none transition-colors",
        preview && "cursor-default",
        item.disabled
          ? "opacity-40"
          : preview
            ? item.danger
              ? "text-[#ff453a]"
              : ""
            : item.danger
              ? "text-[#ff453a] hover:bg-[#ff453a] hover:text-white"
              : "hover:bg-mac-blue hover:text-white",
        open && !preview && !item.danger && "bg-mac-blue text-white",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center">{item.icon}</span>
      <span className="flex-1 truncate">{item.label}</span>
      {item.checked && <Check className="size-3.5" strokeWidth={2.6} />}
      {item.shortcut && (
        <span className="ml-4 text-[11px] opacity-50">{item.shortcut}</span>
      )}
      {submenu && (
        <ChevronRight
          className={clsx("size-3.5 shrink-0 opacity-60", item.shortcut && "ml-1")}
          strokeWidth={2.2}
        />
      )}
    </button>
  );

  if (!submenu) return row;

  return (
    <div
      ref={wrapper}
      className="relative"
      onMouseEnter={cancelClose}
      onMouseLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        scheduleClose();
      }}
    >
      {row}
      {open &&
        createPortal(
          <div
            ref={flyout}
            role="menu"
            aria-label={item.label}
            data-menu-surface
            onMouseEnter={cancelClose}
            onMouseLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                return;
              }
              scheduleClose();
            }}
            style={{
              left: box?.left ?? -9999,
              top: box?.top ?? -9999,
              width: SUBMENU_WIDTH,
              maxHeight: box?.maxHeight,
            }}
            className={clsx(
              MENU_SURFACE_CLASS,
              "fixed z-[110] min-w-[200px] overflow-y-auto",
            )}
          >
            <MenuSurface
              items={item.children!}
              preview={preview}
              onSelect={onSelect}
              depth={depth + 1}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

/** A menu list; each surface tracks its own open flyout. */
export function MenuSurface({
  items,
  preview,
  onSelect,
  depth = 0,
}: {
  items: MenuItem[];
  preview: boolean;
  onSelect?: () => void;
  depth?: number;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <>
      {items.map((item, index) => (
        <MenuItemRow
          key={item.id ?? `item-${index}`}
          item={item}
          index={index}
          preview={preview}
          onSelect={onSelect}
          onOpenSubmenu={setOpenId}
          open={openId === item.id}
          depth={depth}
        />
      ))}
    </>
  );
}

export function PopupMenu({
  x,
  y,
  items,
  onClose,
  minWidth = 208,
  zIndex = 100,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  minWidth?: number;
  /** Raise it above a modal: HeroUI's backdrop sits at 100000. */
  zIndex?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const nextX = Math.min(x, window.innerWidth - rect.width - 8);
    const nextY = Math.min(y, window.innerHeight - rect.height - 8);
    setPosition({ x: Math.max(8, nextX), y: Math.max(8, nextY) });
  }, [x, y, items]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (ref.current?.contains(target as Node)) return;
      // Flyouts are portalled to <body>; a click inside one is still "inside".
      if (target?.closest("[data-menu-surface]")) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onScroll = (event: Event) => {
      // Scrolling inside the menu (a long submenu) must not dismiss it.
      if (ref.current?.contains(event.target as Node)) return;
      if ((event.target as HTMLElement | null)?.closest?.("[data-menu-surface]")) return;
      onClose();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onScroll, true);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-menu-surface
      style={{
        left: position.x,
        top: position.y,
        minWidth,
        maxHeight: `calc(100vh - ${VIEWPORT_PADDING * 2}px)`,
        zIndex,
      }}
      className={clsx(
        "animate-fade-in fixed overflow-y-auto",
        MENU_SURFACE_CLASS,
      )}
    >
      <MenuSurface items={items} preview={false} onSelect={onClose} />
    </div>,
    document.body,
  );
}

/** Static menu used by the settings preview (same rows, no actions). */
export function MenuPreview({
  items,
  label,
}: {
  items: MenuItem[];
  label?: string;
}) {
  return (
    <div
      role="menu"
      aria-label={label}
      data-menu-surface
      className={clsx(MENU_SURFACE_CLASS, "max-h-[70vh] overflow-y-auto")}
    >
      <MenuSurface items={items} preview />
    </div>
  );
}
