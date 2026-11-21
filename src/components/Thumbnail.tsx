import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { clsx } from "clsx";
import { useInView } from "../hooks/useInView";

/**
 * Lazy image thumbnail.
 *
 * The request only starts once the tile is near the viewport, and the SF Symbol
 * fallback crossfades out as the bitmap arrives. When the image is already in
 * the browser cache the `<img>` is complete on mount, so the check below keeps
 * it from flashing the placeholder again on every navigation.
 */
export function Thumbnail({
  url,
  size,
  fallback,
  rounded = 3,
}: {
  url: string;
  size: number;
  fallback: ReactNode;
  rounded?: number;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    if (loaded) return;
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0) setLoaded(true);
  });

  return (
    <span
      ref={ref}
      className="relative grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <span
        aria-hidden="true"
        className={clsx(
          "absolute inset-0 grid place-items-center transition-opacity duration-150",
          loaded && !failed ? "opacity-0" : "opacity-100",
        )}
      >
        {fallback}
      </span>

      {inView && !failed && (
        <img
          ref={imgRef}
          src={url}
          alt=""
          draggable={false}
          decoding="async"
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={clsx(
            "relative object-contain transition-opacity duration-150",
            loaded ? "opacity-100" : "opacity-0",
          )}
          /* Same visual size as the generated pages and Shell icons. */
          style={{
            width: Math.round(size * 0.86),
            height: Math.round(size * 0.86),
            borderRadius: rounded,
          }}
        />
      )}
    </span>
  );
}
