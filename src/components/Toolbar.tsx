import {
  Button,
  Dropdown,
  Label,
  SearchField,
  Separator,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@heroui/react";
import type { Key } from "@heroui/react";
import type { ReactNode } from "react";
import {
  SFArrowClockwise,
  SFArrowUpArrowDown,
  SFArrowUpRightSquare,
  SFCheckmark,
  SFChevronLeft,
  SFChevronRight,
  SFChevronUp,
  SFEllipsis,
  SFEye,
  SFFolderBadgePlus,
  SFLine3Horizontal,
  SFListBullet,
  SFSidebarRight,
  SFSquareGrid2x2,
} from "sf-symbols-lib/dualtone";
import { Loader2 } from "lucide-react";
import type { SortKey, ViewMode } from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { GROUP_LABELS } from "../lib/grouping";
import type { GroupKey } from "../lib/grouping";

const GROUP_KEYS = Object.keys(GROUP_LABELS) as GroupKey[];

const SORT_LABELS: Record<SortKey, string> = {
  name: "名称",
  date: "修改日期",
  size: "大小",
  kind: "种类",
};

const SORT_KEYS = Object.keys(SORT_LABELS) as SortKey[];

function IconButton({
  label,
  disabled,
  onPress,
  children,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip delay={500}>
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={label}
        isDisabled={disabled}
        onPress={onPress}
      >
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

const SEGMENT_CLASS =
  "size-6 min-w-6 rounded-[5px] border-0 bg-transparent px-0 text-mac-muted data-[hovered=true]:bg-black/[0.04] data-[hovered=true]:text-mac-text data-[selected=true]:bg-mac-surface data-[selected=true]:text-mac-text data-[selected=true]:shadow-sm dark:data-[hovered=true]:bg-white/10";

export function Toolbar() {
  const history = useExplorer((state) => state.history);
  const historyIndex = useExplorer((state) => state.historyIndex);
  const view = useExplorer((state) => state.view);
  const setView = useExplorer((state) => state.setView);
  const sortKey = useExplorer((state) => state.sortKey);
  const sortDir = useExplorer((state) => state.sortDir);
  const setSort = useExplorer((state) => state.setSort);
  const groupKey = useExplorer((state) => state.groupKey);
  const setGroup = useExplorer((state) => state.setGroup);
  const query = useExplorer((state) => state.query);
  const setQuery = useExplorer((state) => state.setQuery);
  const searching = useExplorer((state) => state.searching);
  const openDialog = useExplorer((state) => state.openDialog);
  const goBack = useExplorer((state) => state.goBack);
  const goForward = useExplorer((state) => state.goForward);
  const goUp = useExplorer((state) => state.goUp);
  const reload = useExplorer((state) => state.reload);
  const path = useExplorer((state) => state.path);
  const reveal = useExplorer((state) => state.reveal);
  const showHidden = useExplorer((state) => state.showHidden);
  const toggleHidden = useExplorer((state) => state.toggleHidden);
  const previewOpen = useExplorer((state) => state.previewOpen);
  const togglePreview = useExplorer((state) => state.togglePreview);

  const handleViewChange = (keys: Set<Key>) => {
    const next = Array.from(keys)[0];
    if (next === "grid" || next === "list") setView(next as ViewMode);
  };

  const handleMoreAction = (key: Key) => {
    switch (String(key)) {
      case "hidden":
        toggleHidden();
        break;
      case "reveal":
        void reveal(path);
        break;
      case "refresh":
        reload();
        break;
    }
  };

  return (
    <div
      data-toolbar
      className="flex h-12 shrink-0 items-center gap-1 border-b border-mac-line bg-mac-chrome/60 px-4 backdrop-blur-xl"
    >
      <div className="flex items-center gap-0.5">
        <IconButton label="后退" disabled={historyIndex <= 0} onPress={goBack}>
          <SFChevronLeft size={16} />
        </IconButton>
        <IconButton
          label="前进"
          disabled={historyIndex >= history.length - 1}
          onPress={goForward}
        >
          <SFChevronRight size={16} />
        </IconButton>
        <IconButton label="上一级" disabled={!path} onPress={goUp}>
          <SFChevronUp size={16} />
        </IconButton>
      </div>

      <div className="mx-1 h-5 w-px bg-mac-line" />

      <ToggleButtonGroup
        aria-label="视图"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[view]}
        onSelectionChange={handleViewChange}
        size="sm"
        className="gap-0 rounded-[7px] border-0 bg-black/[0.06] p-0.5 dark:bg-white/10"
      >
        <ToggleButton
          id="grid"
          isIconOnly
          aria-label="图标视图"
          className={SEGMENT_CLASS}
        >
          <SFSquareGrid2x2 size={16} />
        </ToggleButton>
        <ToggleButton
          id="list"
          isIconOnly
          aria-label="列表视图"
          className={SEGMENT_CLASS}
        >
          <ToggleButtonGroup.Separator className="bg-black/10 dark:bg-white/10" />
          <SFListBullet size={16} />
        </ToggleButton>
      </ToggleButtonGroup>

      <Dropdown>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 px-2 text-[12.5px] text-mac-muted"
          aria-label={`排序：${SORT_LABELS[sortKey]}`}
        >
          <SFArrowUpArrowDown size={16} />
          <span>{SORT_LABELS[sortKey]}</span>
        </Button>
        <Dropdown.Popover placement="bottom start" className="min-w-[208px]">
          <Dropdown.Menu onAction={(key) => setSort(String(key) as SortKey)}>
            {SORT_KEYS.map((key) => (
              <Dropdown.Item key={key} id={key} textValue={SORT_LABELS[key]}>
                <Label>{SORT_LABELS[key]}</Label>
                {sortKey === key && (
                  <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted">
                    {sortDir === "asc" ? "↑" : "↓"}
                    <SFCheckmark size={14} />
                  </span>
                )}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <Dropdown>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 px-2 text-[12.5px] text-mac-muted"
          aria-label={`分组：${GROUP_LABELS[groupKey]}`}
        >
          <SFLine3Horizontal size={16} />
          <span>{groupKey === "none" ? "分组" : GROUP_LABELS[groupKey]}</span>
        </Button>
        <Dropdown.Popover placement="bottom start" className="min-w-[184px]">
          <Dropdown.Menu onAction={(key) => setGroup(String(key) as GroupKey)}>
            {GROUP_KEYS.map((key) => (
              <Dropdown.Item key={key} id={key} textValue={GROUP_LABELS[key]}>
                <Label>{GROUP_LABELS[key]}</Label>
                {groupKey === key && (
                  <span className="ml-auto text-muted">
                    <SFCheckmark size={14} />
                  </span>
                )}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <Button
        size="sm"
        variant="ghost"
        className="gap-1.5 px-2 text-[12.5px] text-mac-muted"
        onPress={() => openDialog({ kind: "new-folder" })}
      >
        <SFFolderBadgePlus size={16} />
        <span className="hidden lg:inline">新建文件夹</span>
      </Button>

      <div className="ml-auto flex items-center gap-2">
        <SearchField
          aria-label="搜索"
          value={query}
          onChange={setQuery}
          onSubmit={() => undefined}
          variant="secondary"
          className="w-[200px] xl:w-[240px]"
        >
          <SearchField.Group className="h-7 w-full rounded-md">
            <SearchField.SearchIcon className="size-3.5" />
            <SearchField.Input
              placeholder="搜索"
              className="w-full text-[12.5px] placeholder:text-mac-muted"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  (event.target as HTMLInputElement).blur();
                }
              }}
            />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>

        {searching && (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-mac-muted" />
        )}

        <Tooltip delay={500}>
          <Button
            isIconOnly
            size="sm"
            variant={previewOpen ? "secondary" : "ghost"}
            aria-label={previewOpen ? "隐藏预览面板" : "显示预览面板"}
            className="shrink-0"
            onPress={togglePreview}
          >
            <SFSidebarRight size={16} />
          </Button>
          <Tooltip.Content>
            {previewOpen ? "隐藏预览面板" : "显示预览面板"}
          </Tooltip.Content>
        </Tooltip>

        <Dropdown>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="更多"
            className="shrink-0"
          >
            <SFEllipsis size={18} />
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-[240px]">
            <Dropdown.Menu onAction={handleMoreAction}>
              <Dropdown.Item id="hidden" textValue="显示隐藏文件">
                <SFEye size={14} className="shrink-0 text-muted" />
                <Label>显示隐藏文件</Label>
                {showHidden && <SFCheckmark size={14} className="ml-auto" />}
              </Dropdown.Item>
              <Separator />
              <Dropdown.Item
                id="reveal"
                textValue="在资源管理器中打开"
                isDisabled={!path}
              >
                <SFArrowUpRightSquare size={14} className="shrink-0 text-muted" />
                <Label>在资源管理器中打开</Label>
              </Dropdown.Item>
              <Dropdown.Item id="refresh" textValue="刷新">
                <SFArrowClockwise size={14} className="shrink-0 text-muted" />
                <Label>刷新</Label>
                <span className="ml-auto text-[11px] text-muted">Ctrl+R</span>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
    </div>
  );
}
