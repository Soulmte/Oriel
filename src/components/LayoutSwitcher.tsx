import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { clsx } from "clsx";
import { LayoutGlyph, LAYOUT_LABELS } from "./LayoutGlyph";
import type { PaneLayout } from "../store/explorer";

const SEGMENT_CLASS =
  "size-6 min-w-6 rounded-[5px] border-0 bg-transparent px-0 text-mac-text/70 " +
  "data-[hovered=true]:text-mac-text data-[selected=true]:bg-mac-surface data-[selected=true]:text-mac-text " +
  "data-[selected=true]:shadow-[0_1px_2px_rgba(0,0,0,0.16)] " +
  "dark:data-[selected=true]:bg-white/[0.18] dark:data-[selected=true]:shadow-[0_1px_2px_rgba(0,0,0,0.4)]";

const LAYOUTS: PaneLayout[] = ["1", "2", "3", "4"];

/**
 * Pane layout picker as a segmented control, matching the grid/list switch:
 * one click to 1, 2, 3 or 4 panes, with the current layout highlighted.
 */
export function LayoutSwitcher({
  layout,
  onPick,
  className,
}: {
  layout: PaneLayout;
  onPick: (layout: PaneLayout) => void;
  className?: string;
}) {
  return (
    <ToggleButtonGroup
      aria-label="分区"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[layout]}
      onSelectionChange={(keys) => {
        const next = Array.from(keys)[0];
        if (next !== undefined) onPick(String(next) as PaneLayout);
      }}
      size="sm"
      className={clsx(
        "shrink-0 gap-0 rounded-[7px] border-0 bg-black/[0.06] p-0.5 dark:bg-white/10",
        className,
      )}
    >
      {LAYOUTS.map((option) => (
        <ToggleButton
          key={option}
          id={option}
          isIconOnly
          aria-label={LAYOUT_LABELS[option]}
          className={SEGMENT_CLASS}
        >
          {option !== "1" && (
            <ToggleButtonGroup.Separator className="bg-black/10 dark:bg-white/10" />
          )}
          <LayoutGlyph layout={option} size={15} />
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
