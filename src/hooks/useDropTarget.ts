import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { isInternalDrag, readDragPayload } from "../lib/dnd";

type DropHandler = (paths: string[], event: DragEvent) => void;

/** Every mounted target resets when a drag ends, so highlights never stick. */
const resetCallbacks = new Set<() => void>();
let globalBound = false;

function bindGlobalReset(): void {
  if (globalBound || typeof window === "undefined") return;
  globalBound = true;
  const reset = () => {
    for (const callback of resetCallbacks) callback();
  };
  window.addEventListener("dragend", reset, true);
  window.addEventListener("drop", reset, true);
  window.addEventListener("blur", reset);
}

/**
 * Drop support for one element.
 *
 * The enter/leave counter matters: `dragenter`/`dragleave` also fire for the
 * children of the target, so a naive boolean flickers while the pointer moves
 * across a row. `dragleave` only clears the highlight once the counter reaches
 * zero, which is what makes the target feel stable.
 */
export function useDropTarget({
  onDrop,
  onHover,
  hoverDelay = 600,
  enabled = true,
}: {
  onDrop: DropHandler;
  /** Called once the pointer has rested on the target for `hoverDelay`. */
  onHover?: () => void;
  hoverDelay?: number;
  enabled?: boolean;
}) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    depth.current = 0;
    clearTimer();
    setActive(false);
  }, [clearTimer]);

  useEffect(() => {
    bindGlobalReset();
    resetCallbacks.add(reset);
    return () => {
      resetCallbacks.delete(reset);
      depth.current = 0;
      clearTimer();
    };
  }, [reset, clearTimer]);

  const dropProps = {
    onDragEnter(event: DragEvent) {
      if (!enabled || !isInternalDrag(event)) return;
      event.preventDefault();
      depth.current += 1;
      if (depth.current > 1) return;
      setActive(true);
      if (onHover) {
        clearTimer();
        timer.current = window.setTimeout(() => {
          timer.current = null;
          onHover();
        }, hoverDelay);
      }
    },
    onDragOver(event: DragEvent) {
      if (!enabled || !isInternalDrag(event)) return;
      event.preventDefault();
      // Stop here so the canvas behind the row does not also claim the drop.
      event.stopPropagation();
      event.dataTransfer.dropEffect =
        event.ctrlKey || event.altKey ? "copy" : "move";
    },
    onDragLeave(event: DragEvent) {
      if (!enabled || !isInternalDrag(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current > 0) return;
      clearTimer();
      setActive(false);
    },
    onDrop(event: DragEvent) {
      if (!enabled || !isInternalDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth.current = 0;
      clearTimer();
      setActive(false);
      const paths = readDragPayload(event);
      if (paths && paths.length > 0) onDrop(paths, event);
    },
  };

  return { active, dropProps };
}
