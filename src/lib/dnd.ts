import type { DragEvent } from "react";
import { useExplorer } from "../store/explorer";

/** Custom MIME used for internal file drags (keeps other apps' drops out). */
export const DND_MIME = "application/x-macexplorer-paths";

let ghost: HTMLDivElement | null = null;
let draggedPaths: string[] = [];

/** Paths of the drag in progress; empty when nothing is being dragged. */
export function getDraggedPaths(): string[] {
  return draggedPaths;
}

/**
 * Multi-selection drags get a small count badge instead of the default tile
 * snapshot, which looks nothing like Finder.
 */
function makeGhost(count: number): HTMLDivElement {
  const node = document.createElement("div");
  node.textContent = count > 1 ? `${count} 个项目` : "移动";
  node.style.cssText = [
    "position:fixed",
    "top:-200px",
    "left:-200px",
    "padding:5px 12px",
    "border-radius:9px",
    "font:500 12px/1.4 -apple-system,'Segoe UI',sans-serif",
    "color:#fff",
    "background:rgba(10,132,255,0.92)",
    "box-shadow:0 6px 18px rgba(0,0,0,0.28)",
    "pointer-events:none",
    "white-space:nowrap",
  ].join(";");
  document.body.appendChild(node);
  return node;
}

export function setDragPayload(event: DragEvent, paths: string[]): void {
  draggedPaths = paths;
  useExplorer.getState().beginDrag();
  event.dataTransfer.setData(DND_MIME, JSON.stringify(paths));
  event.dataTransfer.setData("text/plain", paths.join("\n"));
  event.dataTransfer.effectAllowed = "copyMove";

  // Chromium snapshots the image synchronously; removing it on the next frame
  // avoids leaving a stray node in the DOM.
  ghost?.remove();
  ghost = makeGhost(paths.length);
  try {
    event.dataTransfer.setDragImage(ghost, 16, 16);
  } catch {
    // Safari/older engines: the default snapshot is fine.
  }
  window.setTimeout(() => {
    ghost?.remove();
    ghost = null;
  }, 0);
}

if (typeof window !== "undefined") {
  // `dragend` is the only reliable end signal: it fires after a drop, after a
  // cancel and after an escape, whereas `drop` does not fire when cancelled.
  const clear = () => {
    draggedPaths = [];
    window.setTimeout(() => useExplorer.getState().endDrag(), 0);
  };
  window.addEventListener("dragend", clear, true);
  window.addEventListener("blur", clear);
}

export function readDragPayload(event: DragEvent): string[] | null {
  const raw = event.dataTransfer.getData(DND_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return null;
  }
}

/** `getData` is blocked during dragover, so probe the types instead. */
export function isInternalDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(DND_MIME);
}

/** Ctrl (Windows) or Option (macOS) turns a drag into a copy, like Finder. */
export function dragKind(event: DragEvent): "copy" | "move" {
  return event.ctrlKey || event.altKey ? "copy" : "move";
}
