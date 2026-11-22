import { useEffect, useState } from "react";
import type { RefObject } from "react";

export interface MarqueeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Finder-style rubber-band selection: press on empty space, drag, and every
 * entry the rectangle touches becomes selected. Holding Ctrl/⌘/Shift adds to
 * the selection that was already there.
 *
 * Hit testing reads `[data-entry-path]` elements from the DOM, so grid, list
 * and virtualised rows all work without knowing their layout.
 */
export function useMarqueeSelection({
  containerRef,
  getSelection,
  onSelect,
  enabled = true,
}: {
  containerRef: RefObject<HTMLElement | null>;
  getSelection: () => string[];
  onSelect: (paths: string[]) => void;
  enabled?: boolean;
}): MarqueeBox | null {
  const [box, setBox] = useState<MarqueeBox | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !enabled) return;

    let active = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let base: string[] = [];
    let previousUserSelect = "";

    const toContent = (clientX: number, clientY: number) => {
      const rect = element.getBoundingClientRect();
      return {
        x: clientX - rect.left - element.clientLeft + element.scrollLeft,
        y: clientY - rect.top - element.clientTop + element.scrollTop,
      };
    };

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === "touch") return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest("[data-entry]")) return;
      if (
        target.closest(
          "input, textarea, select, button, [role='menu'], [role='dialog'], [data-no-marquee]",
        )
      ) {
        return;
      }
      active = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      base =
        event.ctrlKey || event.metaKey || event.shiftKey ? getSelection() : [];
      previousUserSelect = document.body.style.userSelect;
    };

    const onMove = (event: PointerEvent) => {
      if (!active) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      if (!moved) {
        moved = true;
        document.body.style.userSelect = "none";
      }
      event.preventDefault();

      const rect = element.getBoundingClientRect();
      if (event.clientY < rect.top + 24) element.scrollTop -= 18;
      else if (event.clientY > rect.bottom - 24) element.scrollTop += 18;

      const start = toContent(startX, startY);
      const current = toContent(event.clientX, event.clientY);
      setBox({
        left: Math.min(start.x, current.x),
        top: Math.min(start.y, current.y),
        width: Math.abs(start.x - current.x),
        height: Math.abs(start.y - current.y),
      });

      const selection = {
        left: Math.min(startX, event.clientX),
        top: Math.min(startY, event.clientY),
        right: Math.max(startX, event.clientX),
        bottom: Math.max(startY, event.clientY),
      };

      const hits: string[] = [];
      element.querySelectorAll<HTMLElement>("[data-entry-path]").forEach((node) => {
        const box = node.getBoundingClientRect();
        if (
          box.left < selection.right &&
          box.right > selection.left &&
          box.top < selection.bottom &&
          box.bottom > selection.top
        ) {
          const path = node.dataset.entryPath;
          if (path) hits.push(path);
        }
      });

      onSelect(base.length > 0 ? [...new Set([...base, ...hits])] : hits);
    };

    const finish = () => {
      if (!active) return;
      active = false;
      document.body.style.userSelect = previousUserSelect;
      setBox(null);
      if (moved) {
        // A click follows pointerup; the canvas handler would clear the very
        // selection this drag just made, so swallow exactly that one event.
        const swallow = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          element.removeEventListener("click", swallow, true);
        };
        element.addEventListener("click", swallow, true);
      }
      moved = false;
      base = [];
    };

    element.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);

    return () => {
      element.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.style.userSelect = previousUserSelect;
    };
  }, [containerRef, enabled, getSelection, onSelect]);

  return box;
}
