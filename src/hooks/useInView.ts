import { useEffect, useRef, useState } from "react";

/**
 * "Has this element scrolled into view yet?" — used to defer thumbnail
 * requests until a tile is actually about to be seen.
 *
 * All consumers share a single IntersectionObserver: a grid renders one tile
 * per file, and creating thousands of observers would be far more expensive
 * than the requests we are trying to avoid.
 */

const ROOT_MARGIN = "240px";

type Callback = () => void;

const callbacks = new WeakMap<Element, Callback>();
let sharedObserver: IntersectionObserver | null = null;

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;

  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          const callback = callbacks.get(record.target);
          callbacks.delete(record.target);
          sharedObserver?.unobserve(record.target);
          callback?.();
        }
      },
      { rootMargin: ROOT_MARGIN },
    );
  }

  return sharedObserver;
}

export function useInView<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    if (inView) return;
    const node = ref.current;
    if (!node) return;

    const observer = getObserver();
    if (!observer) {
      setInView(true);
      return;
    }

    callbacks.set(node, () => setInView(true));
    observer.observe(node);

    return () => {
      callbacks.delete(node);
      observer.unobserve(node);
    };
  }, [inView]);

  return { ref, inView };
}
