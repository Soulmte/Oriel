import { useCallback, useEffect, useRef, useState } from "react";
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
  SFArrowDown,
  SFArrowUp,
  SFArrowUpRightSquare,
  SFCheckmark,
  SFChevronDown,
  SFChevronLeft,
  SFChevronRight,
  SFChevronUp,
  SFExternaldriveFill,
  SFEllipsis,
  SFEye,
  SFFolderBadgePlus,
  SFGearshapeFill,
  SFLink,
  SFLine3Horizontal,
  SFListBullet,
  SFSliderHorizontal3,
  SFPlus,
  SFSidebarRight,
  SFSquareGrid2x2,
  SFAppleTerminal,
} from "sf-symbols-lib/dualtone";
import { Loader2 } from "lucide-react";
import { FormatIcon } from "../lib/fileIcons";
import type { SortKey, ViewMode } from "@oriel/shared";
import type { SearchScope } from "../store/explorer";
import { useExplorer } from "../store/explorer";
import { GROUP_LABELS } from "../lib/grouping";
import type { GroupKey } from "../lib/grouping";
import { DENSITY_LABELS, GRID_SIZE_LABELS } from "../lib/appearance";

/**
 * What 新建 offers, in the order people actually reach for it: the documents
 * you make every day first, code formats after. Office entries are real OOXML
 * packages built by the service (an empty file would not open in Word).
 */
const NEW_FILE_TYPES: Array<{
  extension: string;
  label: string;
  /** File name suggested in the dialog. */
  suggested: string;
  content: string;
  template?: "docx" | "xlsx" | "pptx";
}> = [
  { extension: "txt", label: "文本文档", suggested: "新建文本文档", content: "" },
  { extension: "md", label: "Markdown", suggested: "新建 Markdown", content: "# 标题\n\n" },
  {
    extension: "docx",
    label: "Word 文档",
    suggested: "新建 Word 文档",
    content: "",
    template: "docx",
  },
  {
    extension: "xlsx",
    label: "Excel 表格",
    suggested: "新建 Excel 表格",
    content: "",
    template: "xlsx",
  },
  {
    extension: "pptx",
    label: "PowerPoint 演示文稿",
    suggested: "新建演示文稿",
    content: "",
    template: "pptx",
  },
  { extension: "csv", label: "CSV 表格", suggested: "新建表格", content: "" },
  { extension: "json", label: "JSON", suggested: "新建 JSON", content: "{\n  \n}\n" },
  { extension: "ts", label: "TypeScript", suggested: "新建 TypeScript", content: "export {};\n" },
  { extension: "js", label: "JavaScript", suggested: "新建 JavaScript", content: "" },
  {
    extension: "html",
    label: "HTML",
    suggested: "新建 HTML",
    content: '<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="utf-8" />\n    <title>Document</title>\n  </head>\n  <body></body>\n</html>\n',
  },
  { extension: "py", label: "Python", suggested: "新建 Python", content: "" },
];

const SORT_LABELS: Record<SortKey, string> = {
  name: "名称",
  date: "修改日期",
  size: "大小",
  kind: "种类",
};

const SORT_KEYS = Object.keys(SORT_LABELS) as SortKey[];

const SEARCH_SCOPE_LABELS: Record<SearchScope, string> = {
  folder: "当前文件夹",
  disk: "此磁盘",
  all: "所有磁盘",
};
const GROUP_KEYS = Object.keys(GROUP_LABELS) as GroupKey[];

function IconButton({
  label,
  hint,
  disabled,
  onPress,
  children,
}: {
  label: string;
  hint?: string;
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
        className={TOOL_ICON_CLASS}
      >
        {children}
      </Button>
      <Tooltip.Content>
        {label}
        {hint ? ` · ${hint}` : ""}
      </Tooltip.Content>
    </Tooltip>
  );
}

/** macOS toolbar button: 28px hit area, 6px radius, quiet hover. */
const TOOL_ICON_CLASS =
  "size-7 min-w-7 shrink-0 rounded-[6px] border-0 bg-transparent p-0 text-mac-text/75 " +
  "data-[hovered=true]:bg-black/[0.06] data-[hovered=true]:text-mac-text " +
  "data-[pressed=true]:bg-black/[0.1] " +
  "data-[disabled=true]:opacity-35 dark:data-[hovered=true]:bg-white/10 dark:data-[pressed=true]:bg-white/15";

const SEGMENT_CLASS =
  "size-6 min-w-6 rounded-[5px] border-0 bg-transparent px-0 text-mac-text/70 " +
  "data-[hovered=true]:text-mac-text data-[selected=true]:bg-mac-surface data-[selected=true]:text-mac-text " +
  "data-[selected=true]:shadow-[0_1px_2px_rgba(0,0,0,0.16)] " +
  "dark:data-[selected=true]:bg-white/[0.18] dark:data-[selected=true]:shadow-[0_1px_2px_rgba(0,0,0,0.4)]";

/** Popup button: icon + optional label + chevron, no chrome until hover. */
const TOOL_BUTTON_CLASS =
  "h-7 gap-1.5 rounded-[6px] border-0 bg-transparent px-2 text-[12.5px] text-mac-text/80 " +
  "data-[hovered=true]:bg-black/[0.06] data-[hovered=true]:text-mac-text " +
  "data-[pressed=true]:bg-black/[0.1] dark:data-[hovered=true]:bg-white/10";

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
  const searchScope = useExplorer((state) => state.searchScope);
  const setSearchScope = useExplorer((state) => state.setSearchScope);
  const searching = useExplorer((state) => state.searching);
  const openDialog = useExplorer((state) => state.openDialog);
  const goBack = useExplorer((state) => state.goBack);
  const goForward = useExplorer((state) => state.goForward);
  const goUp = useExplorer((state) => state.goUp);
  const reload = useExplorer((state) => state.reload);
  const path = useExplorer((state) => state.path);
  const reveal = useExplorer((state) => state.reveal);
  const showHidden = useExplorer((state) => state.showHidden);
  const setShowHidden = useExplorer((state) => state.setShowHidden);
  const previewOpen = useExplorer((state) => state.previewOpen);
  const togglePreview = useExplorer((state) => state.togglePreview);
  const openSettings = useExplorer((state) => state.openSettings);
  const openTerminal = useExplorer((state) => state.openTerminal);
  const notify = useExplorer((state) => state.notify);
  const appearance = useExplorer((state) => state.appearance);
  const setAppearance = useExplorer((state) => state.setAppearance);

  /** Collapse text labels when the window (or the UI scale) gets narrow. */
  const bar = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = bar.current;
    if (!node) return;
    const update = () => setWidth(node.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const showLabels = width === 0 || width >= 860;

  const handleViewChange = (keys: Set<Key>) => {
    const next = Array.from(keys)[0];
    if (next === "grid" || next === "list") setView(next as ViewMode);
  };

  const handleSortAction = (key: Key) => {
    const value = String(key);
    if (value === "dir-asc" || value === "dir-desc") {
      const wanted = value === "dir-asc" ? "asc" : "desc";
      if (sortDir !== wanted) setSort(sortKey);
      return;
    }
    setSort(value as SortKey);
  };

  const handleMore = useCallback(
    (key: Key) => {
      switch (String(key)) {
        case "hidden":
          setShowHidden(!showHidden);
          break;
        case "reveal":
          void reveal(path);
          break;
        case "terminal":
          void openTerminal();
          break;
        case "copy-path":
          void navigator.clipboard
            .writeText(path)
            .then(() => notify("已复制路径"))
            .catch(() => notify("复制失败"));
          break;
        case "refresh":
          reload();
          break;
        case "settings":
          openSettings();
          break;
      }
    },
    [openSettings, openTerminal, notify, path, reload, reveal, setShowHidden, showHidden],
  );

  const handleViewOption = (key: Key) => {
    const value = String(key);
    if (value.startsWith("size-")) {
      setAppearance("gridSize", value.slice(5) as "sm" | "md" | "lg");
    } else if (value.startsWith("density-")) {
      setAppearance("density", value.slice(8) as "compact" | "comfortable" | "spacious");
    } else if (value === "extensions") {
      setAppearance("showExtensions", !appearance.showExtensions);
    } else if (value === "preview") {
      togglePreview();
    }
  };

  return (
    <div
      ref={bar}
      data-toolbar
      className="flex h-[52px] shrink-0 items-center gap-2.5 overflow-hidden border-b border-mac-line bg-mac-chrome/60 px-2.5 backdrop-blur-xl"
    >
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="后退" hint="Alt+←" disabled={historyIndex <= 0} onPress={goBack}>
          <SFChevronLeft size={16} />
        </IconButton>
        <IconButton
          label="前进"
          hint="Alt+→"
          disabled={historyIndex >= history.length - 1}
          onPress={goForward}
        >
          <SFChevronRight size={16} />
        </IconButton>
        <IconButton label="上一级" hint="Backspace" disabled={!path} onPress={goUp}>
          <SFChevronUp size={16} />
        </IconButton>
        <IconButton label="刷新" hint="F5" disabled={!path} onPress={reload}>
          <SFArrowClockwise size={16} />
        </IconButton>
      </div>

      <ToggleButtonGroup
        aria-label="视图"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[view]}
        onSelectionChange={handleViewChange}
        size="sm"
        className="shrink-0 gap-0 rounded-[7px] border-0 bg-black/[0.06] p-0.5 dark:bg-white/10"
      >
        <ToggleButton id="grid" isIconOnly aria-label="图标视图" className={SEGMENT_CLASS}>
          <SFSquareGrid2x2 size={16} />
        </ToggleButton>
        <ToggleButton id="list" isIconOnly aria-label="列表视图" className={SEGMENT_CLASS}>
          <ToggleButtonGroup.Separator className="bg-black/10 dark:bg-white/10" />
          <SFListBullet size={16} />
        </ToggleButton>
      </ToggleButtonGroup>

      {/* View options: sizes, density, extensions, preview */}
      <Dropdown>
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          className={TOOL_ICON_CLASS}
          aria-label="视图选项"
        >
          <SFSliderHorizontal3 size={16} />
        </Button>
        <Dropdown.Popover placement="bottom start" className="min-w-[232px]">
          <Dropdown.Menu onAction={handleViewOption}>
            {(["sm", "md", "lg"] as const).map((size) => (
              <Dropdown.Item key={`size-${size}`} id={`size-${size}`} textValue={`图标 ${GRID_SIZE_LABELS[size]}`}>
                <Label>图标大小：{GRID_SIZE_LABELS[size]}</Label>
                {appearance.gridSize === size && (
                  <SFCheckmark size={14} className="ml-auto text-muted" />
                )}
              </Dropdown.Item>
            ))}
            <Separator />
            {(["compact", "comfortable", "spacious"] as const).map((density) => (
              <Dropdown.Item
                key={`density-${density}`}
                id={`density-${density}`}
                textValue={`行高 ${DENSITY_LABELS[density]}`}
              >
                <Label>列表密度：{DENSITY_LABELS[density]}</Label>
                {appearance.density === density && (
                  <SFCheckmark size={14} className="ml-auto text-muted" />
                )}
              </Dropdown.Item>
            ))}
            <Separator />
            <Dropdown.Item id="extensions" textValue="显示文件扩展名">
              <Label>显示文件扩展名</Label>
              {appearance.showExtensions && (
                <SFCheckmark size={14} className="ml-auto text-muted" />
              )}
            </Dropdown.Item>
            <Dropdown.Item id="preview" textValue="显示预览面板">
              <Label>显示预览面板</Label>
              {previewOpen && <SFCheckmark size={14} className="ml-auto text-muted" />}
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <Dropdown>
        <Button
          size="sm"
          variant="ghost"
          className={TOOL_BUTTON_CLASS}
          aria-label={`排序：${SORT_LABELS[sortKey]}${sortDir === "asc" ? "升序" : "降序"}`}
        >
          {sortDir === "asc" ? <SFArrowUp size={14} /> : <SFArrowDown size={14} />}
          <span className="whitespace-nowrap">
            {showLabels ? SORT_LABELS[sortKey] : "排序"}
          </span>
          <SFChevronDown size={9} className="opacity-55" />
        </Button>
        <Dropdown.Popover placement="bottom start" className="min-w-[208px]">
          <Dropdown.Menu onAction={handleSortAction}>
            {SORT_KEYS.map((key) => (
              <Dropdown.Item key={key} id={key} textValue={SORT_LABELS[key]}>
                <Label>{SORT_LABELS[key]}</Label>
                {sortKey === key && (
                  <SFCheckmark size={14} className="ml-auto text-muted" />
                )}
              </Dropdown.Item>
            ))}
            <Separator />
            <Dropdown.Item id="dir-asc" textValue="升序">
              <Label>升序</Label>
              {sortDir === "asc" && <SFCheckmark size={14} className="ml-auto text-muted" />}
            </Dropdown.Item>
            <Dropdown.Item id="dir-desc" textValue="降序">
              <Label>降序</Label>
              {sortDir === "desc" && <SFCheckmark size={14} className="ml-auto text-muted" />}
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>

      <Dropdown>
        <Button
          size="sm"
          variant="ghost"
          className={TOOL_BUTTON_CLASS}
          aria-label={`分组：${GROUP_LABELS[groupKey]}`}
        >
          <SFLine3Horizontal size={15} />
          {showLabels && <span className="whitespace-nowrap">分组</span>}
          {groupKey !== "none" && (
            <span className="size-1.5 rounded-full bg-mac-blue" aria-hidden="true" />
          )}
          <SFChevronDown size={9} className="opacity-55" />
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

      <div className="ml-auto flex min-w-0 items-center gap-2">
        <Dropdown>
          <Button
            size="sm"
            variant="ghost"
            className={TOOL_BUTTON_CLASS}
            aria-label={`搜索范围：${SEARCH_SCOPE_LABELS[searchScope]}`}
          >
            {searchScope === "folder" ? (
              <SFFolderBadgePlus size={14} />
            ) : (
              <SFExternaldriveFill size={14} />
            )}
            {showLabels && (
              <span className="whitespace-nowrap">{SEARCH_SCOPE_LABELS[searchScope]}</span>
            )}
            <SFChevronDown size={9} className="opacity-55" />
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-[184px]">
            <Dropdown.Menu onAction={(key) => setSearchScope(String(key) as SearchScope)}>
              {(Object.keys(SEARCH_SCOPE_LABELS) as SearchScope[]).map((scope) => (
                <Dropdown.Item key={scope} id={scope} textValue={SEARCH_SCOPE_LABELS[scope]}>
                  <Label>{SEARCH_SCOPE_LABELS[scope]}</Label>
                  {searchScope === scope && (
                    <SFCheckmark size={14} className="ml-auto text-muted" />
                  )}
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>

        <Dropdown>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            className={TOOL_ICON_CLASS}
            aria-label="新建"
          >
            <SFPlus size={16} />
          </Button>
          <Dropdown.Popover placement="bottom end" className="w-[268px]">
            <Dropdown.Menu
              onAction={(key) => {
                const value = String(key);
                if (value === "folder") {
                  openDialog({ kind: "new-folder" });
                  return;
                }
                const type = NEW_FILE_TYPES.find((item) => item.extension === value);
                if (!type) return;
                openDialog({
                  kind: "new-file",
                  extension: type.extension,
                  label: type.label,
                  content: type.content,
                  suggested: type.suggested,
                  template: type.template,
                });
              }}
            >
              <Dropdown.Item id="folder" textValue="新建文件夹">
                <SFFolderBadgePlus size={16} className="shrink-0 text-muted" />
                <Label>新建文件夹</Label>
                <span className="ml-auto text-[11px] text-muted">Ctrl+Shift+N</span>
              </Dropdown.Item>
              <Separator />
              {NEW_FILE_TYPES.map((type) => (
                <Dropdown.Item
                  key={type.extension}
                  id={type.extension}
                  textValue={`${type.label} .${type.extension}`}
                >
                  <span className="grid size-5 shrink-0 place-items-center">
                    <FormatIcon ext={type.extension} size={20} />
                  </span>
                  <Label>{type.label}</Label>
                  <span className="ml-auto text-[11px] text-muted">
                    .{type.extension}
                  </span>
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
          </Dropdown>

        <SearchField
          aria-label="搜索"
          value={query}
          onChange={setQuery}
          onSubmit={() => undefined}
          variant="secondary"
          className="w-[150px] shrink-0 lg:w-[190px] 2xl:w-[240px]"
        >
          <SearchField.Group className="h-7 w-full rounded-[7px]">
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
            variant="ghost"
            aria-label={previewOpen ? "隐藏预览面板" : "显示预览面板"}
            className={`${TOOL_ICON_CLASS} ${
              previewOpen ? "bg-black/[0.07] text-mac-text dark:bg-white/[0.12]" : ""
            }`}
            onPress={togglePreview}
          >
            <SFSidebarRight size={16} />
          </Button>
          <Tooltip.Content>
            {previewOpen ? "隐藏预览面板 · 空格" : "显示预览面板 · 空格"}
          </Tooltip.Content>
        </Tooltip>

        <Dropdown>
          <Button isIconOnly size="sm" variant="ghost" aria-label="更多" className={TOOL_ICON_CLASS}>
            <SFEllipsis size={18} />
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-[248px]">
            <Dropdown.Menu onAction={handleMore}>
              <Dropdown.Item id="hidden" textValue="显示隐藏文件">
                <SFEye size={14} className="shrink-0 text-muted" />
                <Label>显示隐藏文件</Label>
                <span className="ml-auto text-[11px] text-muted">Ctrl+H</span>
                {showHidden && <SFCheckmark size={14} />}
              </Dropdown.Item>
              <Separator />
              <Dropdown.Item id="reveal" textValue="在资源管理器中打开" isDisabled={!path}>
                <SFArrowUpRightSquare size={14} className="shrink-0 text-muted" />
                <Label>在资源管理器中打开</Label>
              </Dropdown.Item>
              <Dropdown.Item id="terminal" textValue="在此处打开终端" isDisabled={!path}>
                <SFAppleTerminal size={14} className="shrink-0 text-muted" />
                <Label>在此处打开终端</Label>
              </Dropdown.Item>
              <Dropdown.Item id="copy-path" textValue="复制当前路径" isDisabled={!path}>
                <SFLink size={14} className="shrink-0 text-muted" />
                <Label>复制当前路径</Label>
              </Dropdown.Item>
              <Separator />
              <Dropdown.Item id="refresh" textValue="刷新">
                <SFArrowClockwise size={14} className="shrink-0 text-muted" />
                <Label>刷新</Label>
                <span className="ml-auto text-[11px] text-muted">F5</span>
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
