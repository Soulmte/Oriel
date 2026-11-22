import type { PaneLayout } from "../store/explorer";

/**
 * Tiny diagram of the pane arrangement, drawn instead of borrowed from an icon
 * set so 2, 3 and 4 columns read at 14px.
 */
export function LayoutGlyph({
  layout,
  size = 14,
}: {
  layout: PaneLayout;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={Math.round(size * 0.86)}
      viewBox="0 0 14 12"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect
        x="0.75"
        y="0.75"
        width="12.5"
        height="10.5"
        rx="2"
        stroke="currentColor"
        strokeWidth="1"
        opacity="0.5"
      />
      {layout === "2" && (
        <line x1="7" y1="1" x2="7" y2="11" stroke="currentColor" strokeWidth="1" />
      )}
      {layout === "3" && (
        <>
          <line x1="4.9" y1="1" x2="4.9" y2="11" stroke="currentColor" strokeWidth="1" />
          <line x1="9.1" y1="1" x2="9.1" y2="11" stroke="currentColor" strokeWidth="1" />
        </>
      )}
      {layout === "4" && (
        <>
          <line x1="7" y1="1" x2="7" y2="11" stroke="currentColor" strokeWidth="1" />
          <line x1="1" y1="6" x2="13" y2="6" stroke="currentColor" strokeWidth="1" />
        </>
      )}
    </svg>
  );
}

export const LAYOUT_LABELS: Record<PaneLayout, string> = {
  "1": "单窗格",
  "2": "左右两栏",
  "3": "三栏",
  "4": "四象限",
};
