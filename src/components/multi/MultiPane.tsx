import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@heroui/react";
import { clsx } from "clsx";
import { Pane, paneMemory } from "./Pane";
import { useExplorer } from "../../store/explorer";

/**
 * Split file area. Each pane keeps its own folder, history, selection, view and
 * sort; the sidebar and clipboard talk to the focused pane through paneBridge.
 * The layout itself is chosen from the toolbar, not from a strip in here.
 */
export function MultiPane() {
  const layout = useExplorer((state) => state.layout);
  const globalPath = useExplorer((state) => state.path);
  const paneActivePath = useExplorer((state) => state.paneActivePath);
  const exitPanes = useExplorer((state) => state.exitPanes);

  const count = layout === "4" ? 4 : layout === "3" ? 3 : 2;
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (active >= count) setActive(0);
  }, [active, count]);

  // Pane 0 follows the folder the full view was showing; the others keep the
  // folder they had before the layout changed, or start next to it.
  const initialPaths = useMemo(
    () =>
      Array.from({ length: count }, (_, index) =>
        index === 0 ? globalPath : paneMemory[index]?.path || globalPath,
      ),
    [count, globalPath],
  );

  const activePath = paneActivePath || initialPaths[active] || globalPath;

  if (!globalPath) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-mac-surface">
        <Spinner size="sm" />
      </div>
    );
  }

  return (
    <div
      className={clsx(
        "grid min-h-0 flex-1 gap-px bg-mac-line",
        layout === "4"
          ? "grid-cols-2 grid-rows-2"
          : layout === "3"
            ? "grid-cols-3"
            : "grid-cols-2",
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
  );
}
