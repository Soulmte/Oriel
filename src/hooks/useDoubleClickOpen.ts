import { useCallback, useRef } from "react";

/** A second click on the same entry within this window opens it. */
const DOUBLE_CLICK_MS = 900;
/** A native dblclick and our own detector can both fire; open only once. */
const OPEN_DEDUPE_MS = 350;

/**
 * Open an entry without relying on the browser's `dblclick` event.
 *
 * `dblclick` is only emitted when both presses land inside the OS double-click
 * distance *and* time. Touchpads, touch screens and a fast Windows double-click
 * setting all break that in the field, which reads as "sometimes folders do not
 * open". Remembering the previous click lets the second one open the entry even
 * when the browser never reports a double-click.
 */
export function useDoubleClickOpen(open: () => void, singleClick = false) {
  const lastClick = useRef<{ path: string; at: number } | null>(null);
  const lastOpen = useRef(0);

  const trigger = useCallback(() => {
    const now = Date.now();
    if (now - lastOpen.current < OPEN_DEDUPE_MS) return;
    lastOpen.current = now;
    open();
  }, [open]);

  return useCallback(
    (
      path: string,
      event: {
        detail?: number;
        ctrlKey: boolean;
        metaKey: boolean;
        shiftKey: boolean;
      },
    ) => {
      // Modifier clicks build a selection; they never open.
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        lastClick.current = null;
        return;
      }
      // Keyboard activation (Enter/Space) arrives with detail 0; the global
      // shortcut handles opening those.
      if (!event.detail) return;
      if (event.detail >= 2) {
        lastClick.current = null;
        trigger();
        return;
      }

      const now = Date.now();
      // Web-style mode: the first press opens. Selection happened already in the
      // click handler, so the row the user clicked is what gets opened.
      if (singleClick) {
        lastClick.current = null;
        trigger();
        return;
      }

      const previous = lastClick.current;
      if (previous && previous.path === path && now - previous.at <= DOUBLE_CLICK_MS) {
        lastClick.current = null;
        trigger();
        return;
      }
      lastClick.current = { path, at: now };
    },
    [trigger, singleClick],
  );
}
