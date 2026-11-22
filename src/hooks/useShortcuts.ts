import { useEffect } from "react";
import type { EntryDto } from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { EDIT_PATH_EVENT } from "../lib/pathEvents";

function findEntry(entryPath: string | undefined): EntryDto | undefined {
  if (!entryPath) return undefined;
  const state = useExplorer.getState();
  return (
    state.entries.find((entry) => entry.path === entryPath) ??
    state.results?.find((entry) => entry.path === entryPath)
  );
}

export function useShortcuts() {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const state = useExplorer.getState();
      const target = event.target as HTMLElement | null;
      const typing = target?.closest(
        "input, textarea, select, [contenteditable='true']",
      );

      if (typing) {
        if (event.key === "Escape") {
          state.setQuery("");
          target?.blur();
        }
        return;
      }

      // Let HeroUI collections, overlays and the app chrome handle their own
      // keyboard interactions instead of hijacking them for file actions.
      if (
        target?.closest(
          "[role='listbox'], [role='menu'], [role='dialog'], [data-toolbar], [data-titlebar]",
        )
      ) {
        return;
      }

      if (state.dialog) return;

      const key = event.key.toLowerCase();
      const ctrl = event.ctrlKey || event.metaKey;

      if (ctrl && event.key === ",") {
        event.preventDefault();
        state.openSettings();
        return;
      }

      // The start page is a launcher, not a listing: none of the file
      // shortcuts should act on the folder behind it.
      if (state.route === "home") return;

      // Standalone tool pages only answer to Escape (back to the listing).
      if (state.route === "processes") {
        if (event.key === "Escape") {
          event.preventDefault();
          state.closeProcesses();
        }
        return;
      }

      if (state.route === "ports") {
        if (event.key === "Escape") {
          event.preventDefault();
          state.closePorts();
        }
        return;
      }

      if (state.route === "cleanup") {
        if (event.key === "Escape") {
          event.preventDefault();
          state.closeCleanup();
        }
        return;
      }

      if (state.route === "uninstaller") {
        if (event.key === "Escape") {
          event.preventDefault();
          state.closeUninstaller();
        }
        return;
      }

      // Split view owns its own selection, navigation and menus. Let the
      // focused pane handle the key; only global actions above still apply.
      if (state.layout !== "1") return;

      if (ctrl && key === "f") {
        event.preventDefault();
        const input = document.querySelector<HTMLInputElement>("[data-search-input]");
        input?.focus();
        input?.select();
        return;
      }

      if (ctrl && key === "i") {
        event.preventDefault();
        const targets =
          state.selected.length > 0
            ? state.selected
            : state.path
              ? [state.path]
              : [];
        if (targets.length > 0) {
          state.openDialog({ kind: "properties", paths: targets });
        }
        return;
      }

      if (ctrl && event.key === "1") {
        event.preventDefault();
        state.setView("grid");
        return;
      }

      if (ctrl && event.key === "2") {
        event.preventDefault();
        state.setView("list");
        return;
      }

      if (state.route === "recycle") {
        if (event.key === "Escape") {
          event.preventDefault();
          state.closeRecycle();
        }
        if (event.key === "F5") {
          event.preventDefault();
          void state.loadRecycle();
        }
        return;
      }

      if (state.route === "settings") {
        if (event.key === "Escape") {
          event.preventDefault();
          state.closeSettings();
        }
        return;
      }

      if (event.key === "Escape") {
        if (state.contextMenu) state.setContextMenu(null);
        else if (state.query) state.setQuery("");
        else if (state.previewOpen) state.setPreviewOpen(false);
        else state.clearSelection();
        return;
      }

      if (event.code === "Space" || event.key === " ") {
        if (state.previewOpen) {
          event.preventDefault();
          state.setPreviewOpen(false);
        } else if (state.selected.length > 0) {
          event.preventDefault();
          state.setPreviewOpen(true);
        }
        return;
      }

      if (ctrl && event.shiftKey && key === "n") {
        event.preventDefault();
        state.openDialog({ kind: "new-folder" });
        return;
      }

      if (ctrl && key === "a") {
        event.preventDefault();
        state.selectAll();
        return;
      }
      if (ctrl && key === "c") {
        event.preventDefault();
        state.copySelection("copy");
        return;
      }
      if (ctrl && key === "x") {
        event.preventDefault();
        state.copySelection("cut");
        return;
      }
      if (ctrl && key === "v") {
        event.preventDefault();
        void state.paste();
        return;
      }
      if (ctrl && key === "r") {
        event.preventDefault();
        state.reload();
        return;
      }
      if (ctrl && key === "h") {
        event.preventDefault();
        state.toggleHidden();
        return;
      }
      if (ctrl && event.key === "[") {
        event.preventDefault();
        state.goBack();
        return;
      }
      if (ctrl && event.key === "]") {
        event.preventDefault();
        state.goForward();
        return;
      }
      if (ctrl && key === "l") {
        event.preventDefault();
        window.dispatchEvent(new Event(EDIT_PATH_EVENT));
        return;
      }
      if (ctrl && key === "z") {
        event.preventDefault();
        void state.undo();
        return;
      }

      if (event.key === "F2") {
        if (state.selected.length > 1) {
          event.preventDefault();
          state.openDialog({ kind: "batch-rename", paths: [...state.selected] });
          return;
        }
        const entry = findEntry(state.selected[0]);
        if (entry) {
          event.preventDefault();
          state.openDialog({ kind: "rename", entry });
        }
        return;
      }

      if (event.key === "F5") {
        event.preventDefault();
        state.reload();
        return;
      }

      if (event.key === "Delete") {
        if (state.selected.length > 0) {
          event.preventDefault();
          void state.removePaths(state.selected, event.shiftKey);
        }
        return;
      }

      if (event.key === "Enter") {
        const entry = findEntry(state.selected[0]);
        if (entry) {
          event.preventDefault();
          void state.openEntry(entry);
        }
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        state.goUp();
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        state.moveSelection(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        state.moveSelection(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        state.moveSelection(1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        state.moveSelection(-1);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
