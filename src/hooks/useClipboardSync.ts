import { useEffect } from "react";
import { useExplorer } from "../store/explorer";

/**
 * Explorer, QQ and every other program can replace the system clipboard
 * behind our back. Re-reading it when the window regains focus keeps Ctrl+V
 * meaningful without paying for a PowerShell round trip on every keypress.
 */
export function useClipboardSync() {
  useEffect(() => {
    let timer: number | undefined;
    let last = 0;

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const now = Date.now();
        if (now - last < 800) return;
        last = now;
        void useExplorer.getState().syncClipboard();
      }, 250);
    };

    schedule();
    window.addEventListener("focus", schedule);
    const onVisibility = () => {
      if (!document.hidden) schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
}
