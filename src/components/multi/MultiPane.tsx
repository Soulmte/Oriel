import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@heroui/react";
import { clsx } from "clsx";
import { Pane, paneMemory } from "./Pane";
import { useExplorer } from "../../store/explorer";
import type { PaneLayout } from "../../store/explorer";

const LAYOUTS: Array<{ id: PaneLayout; label: string }> = [
  { id: "1", label: "单窗格" },
  { id: "2", label: "左右两格" },
  { id: "4", label: "四宫格" },
];

/**
 * Split file area. Each pane keeps its own folder, history, selection, view and
 * sort; the sidebar and clipboard talk to the focused pane through paneBridge.
 */
export function MultiPane() {
  const layout = useExplorer((state) => state.layout);
  const globalPath = useExplorer((state) => state.path);
  const paneActivePath = useExplorer((state) => state.paneActivePath);
  const setLayout = useExplorer((state) => state.setLayout);
  const exitPanes = useExplorer((state) => state.exitPanes);

  const count = layout === "4" ? 4 : 2;
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (active >= count) setActive(0);
  }, [active, count]);

  // Pane 0 follows the folder the full view was showing; the others keep the
  // folder they had before the layout changed, or start next to it.
  const initialPaths = useMemo(
    () =>
      Array.from({ length: count }, (_, index) =>
        index === 0
          ? globalPath
          : paneMemory[index]?.path || globalPath,
      ),
    [count, globalPath],
  );

  const activePath =
    paneActivePath || initialPaths[active] || globalPath;

  if (!globalPath) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-mac-surface">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-mac-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-mac-line bg-mac-chrome/60 px-2.5">
        <span className="text-[11px] font-medium text-mac-muted">分区</span>
        <div className="flex items-center gap-0.5">
          {LAYOUTS.map((option) => {
            const selected = option.id === layout;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  if (option.id === "1") {
                    exitPanes(activePath);
                    return;
                  }
                  setLayout(option.id);
                }}
                className={clsx(
                  "h-6 rounded-[5px] px-2 text-[11.5px] transition-colors",
                  selected
                    ? "bg-mac-surface font-medium text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)]"
                    : "text-mac-muted hover:bg-black/[0.05] hover:text-mac-text dark:hover:bg-white/[0.07]",
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <span className="ml-auto hidden truncate text-[10.5px] text-mac-muted md:inline">
          点击窗格切换 · 拖动文件到另一窗格可复制或移动
        </span>
      </div>

      <div
        className={clsx(
          "grid min-h-0 flex-1 gap-px bg-mac-line",
          count === 4 ? "grid-cols-2 grid-rows-2" : "grid-cols-2",
        )}
      >
        {initialPaths.map((path, index) => (
          <Pane
            key={index}
            index={index}
            initialPath={path}
            active={active === index}
            onActivate={() => setActive(index)}
            onExit={exitPanes}
          />
        ))}
      </div>
    </div>
  );
}
