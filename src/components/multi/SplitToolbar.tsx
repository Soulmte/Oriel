import { Button, Dropdown, Label } from "@heroui/react";
import {
  SFArrowClockwise,
  SFChevronDown,
  SFEllipsis,
  SFGearshapeFill,
} from "sf-symbols-lib/dualtone";
import { LayoutSwitcher } from "../LayoutSwitcher";
import { paneBridge } from "../../lib/paneBridge";
import { useExplorer } from "../../store/explorer";
import type { PaneLayout } from "../../store/explorer";

const BUTTON_CLASS =
  "h-7 gap-1.5 rounded-[6px] border-0 bg-transparent px-2 text-[12.5px] text-mac-text/80 " +
  "data-[hovered=true]:bg-black/[0.06] data-[hovered=true]:text-mac-text " +
  "data-[pressed=true]:bg-black/[0.1] dark:data-[hovered=true]:bg-white/10";

/**
 * Toolbar for split view. Navigation, view and sort live inside each pane, so
 * this bar only keeps what is global: the layout switch itself and the menu.
 */
export function SplitToolbar() {
  const layout = useExplorer((state) => state.layout);
  const setLayout = useExplorer((state) => state.setLayout);
  const exitPanes = useExplorer((state) => state.exitPanes);
  const paneActivePath = useExplorer((state) => state.paneActivePath);
  const path = useExplorer((state) => state.path);
  const openSettings = useExplorer((state) => state.openSettings);

  const pick = (next: PaneLayout) => {
    if (next === "1") {
      exitPanes(paneActivePath || path);
      return;
    }
    setLayout(next);
  };

  return (
    <div
      data-toolbar
      className="flex h-[52px] shrink-0 items-center gap-2.5 border-b border-mac-line bg-mac-chrome/60 px-2.5 backdrop-blur-xl"
    >
      <LayoutSwitcher layout={layout} onPick={pick} />
      <span className="min-w-0 truncate text-[11.5px] text-mac-muted">
        点击窗格切换 · 拖动文件到另一窗格可复制或移动
      </span>

      <div className="ml-auto flex items-center gap-2">
        <Dropdown>
          <Button size="sm" variant="ghost" className={BUTTON_CLASS} aria-label="更多">
            <SFEllipsis size={15} />
            <span className="whitespace-nowrap">更多</span>
            <SFChevronDown size={9} className="opacity-55" />
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-[184px]">
            <Dropdown.Menu
              onAction={(key) => {
                if (String(key) === "refresh") {
                  paneBridge.active?.refresh();
                  return;
                }
                if (String(key) === "settings") openSettings();
              }}
            >
              <Dropdown.Item id="refresh" textValue="刷新当前窗格">
                <SFArrowClockwise size={14} className="shrink-0 text-muted" />
                <Label>刷新当前窗格</Label>
              </Dropdown.Item>
              <Dropdown.Item id="settings" textValue="设置">
                <SFGearshapeFill size={14} className="shrink-0 text-muted" />
                <Label>设置</Label>
                <span className="ml-auto text-[11px] text-muted">Ctrl+,</span>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
    </div>
  );
}
