import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Minimal row virtualizer.
 *
 * A folder can hold thousands of entries; mounting one DOM node (and one SF
 * Symbol) per entry freezes the window. Only the rows around the viewport are
 * rendered here, so scrolling stays smooth regardless of folder size.
 */
export function useVirtualRows({
  count,
  rowHeight,
  columns = 1,
  overscan = 6,
}: {
  count: number;
  rowHeight: number;
  columns?: number;
  overscan?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const frame = useRef(0);
  const latest = useRef(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    const measure = () => setViewportHeight(node.clientHeight);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    // Keep the newest position: a frame can see several scroll events, and the
    // one that must be rendered is the last one.
    latest.current = event.currentTarget.scrollTop;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setScrollTop(latest.current);
    });
  }, []);

  const rows = Math.max(0, Math.ceil(count / Math.max(1, columns)));
  const visibleRows = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rows, first + visibleRows);

  return {
    ref,
    onScroll,
    rows,
    first,
    last,
    scrollTop,
    viewportHeight,
  };
}
