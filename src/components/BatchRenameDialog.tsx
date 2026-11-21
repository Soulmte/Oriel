import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Modal } from "@heroui/react";
import { AlertTriangle, Check, ChevronDown, Pencil } from "lucide-react";
import { useExplorer } from "../store/explorer";
import {
  DEFAULT_BATCH_RENAME,
  planBatchRename,
  toRequestItems,
} from "../lib/batchRename";
import type { BatchRenameOptions } from "../lib/batchRename";
import { PopupMenu } from "./PopupMenu";
import type { MenuItem } from "./PopupMenu";

/* ---------------------------------------------------------------- controls */

/** One filled text/number field in the macOS "text field" style. */
const FIELD_CLASS =
  "h-7 w-full min-w-0 rounded-[6px] bg-mac-surface px-2 text-[12px] leading-none text-mac-text " +
  "shadow-[0_0_0_1px_var(--color-mac-line)] outline-none transition-[box-shadow] duration-100 " +
  "placeholder:text-mac-muted/80 " +
  "focus:shadow-[0_0_0_1px_var(--color-mac-blue),0_0_0_3px_var(--color-mac-blue-soft)]";

const NUMBER_CLASS =
  FIELD_CLASS +
  " appearance-none tabular-nums [&::-webkit-inner-spin-button]:appearance-none " +
  "[&::-webkit-outer-spin-button]:appearance-none";

/** A group of settings: quiet label above, one bordered box with hairline rows. */
function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="pl-2.5 text-[11px] font-medium text-mac-muted">{label}</h3>
      <div className="flex flex-col divide-y divide-mac-line overflow-hidden rounded-[10px] bg-mac-chrome">
        {children}
      </div>
    </section>
  );
}

/** A row keeps its label in a fixed 44px column so every control starts on one line. */
function Row({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: React.ReactNode;
  align?: "center" | "start";
}) {
  return (
    <div
      className={`flex gap-2 px-2.5 py-[5px] ${
        align === "center" ? "items-center" : "items-start"
      }`}
    >
      <span className="w-11 shrink-0 text-[12px] leading-7 text-mac-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** macOS segmented control: one track, a raised pill for the selected item. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 rounded-[7px] bg-black/[0.06] p-[2px] dark:bg-white/[0.09]"
    >
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            className={`h-[22px] rounded-[5px] px-2 text-[11.5px] transition-colors duration-100 ${
              selected
                ? "bg-mac-surface font-medium text-mac-text shadow-[0_1px_2px_rgba(0,0,0,0.14)] dark:bg-white/[0.18] dark:shadow-[0_1px_2px_rgba(0,0,0,0.4)]"
                : "text-mac-muted hover:text-mac-text"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** macOS checkbox: 14px rounded square, accent fill with a white tick. */
function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="group flex items-center gap-1.5 text-[12px] text-mac-text"
    >
      <span
        className={`grid size-[14px] shrink-0 place-items-center rounded-[3.5px] transition-colors duration-100 ${
          checked
            ? "bg-mac-blue text-white"
            : "bg-mac-surface text-transparent shadow-[0_0_0_1px_var(--color-mac-line)]"
        }`}
      >
        <Check className="size-2.5" strokeWidth={3} />
      </span>
      {label}
    </button>
  );
}

/** Popup button: a field-shaped trigger that opens the app's own menu. */
function Popup<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
  label: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const current = options.find((option) => option.id === value);

  const items: MenuItem[] = options.map((option) => ({
    id: option.id,
    label: option.label,
    checked: option.id === value,
    onSelect: () => {
      onChange(option.id);
      setAt(null);
    },
  }));

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        onClick={() => {
          const rect = trigger.current?.getBoundingClientRect();
          if (!rect) return;
          setAt({ x: rect.left, y: rect.bottom + 4 });
        }}
        className={`${FIELD_CLASS} flex items-center justify-between gap-1 text-left`}
      >
        <span className="truncate">{current?.label}</span>
        <ChevronDown className="size-3 shrink-0 text-mac-muted" />
      </button>
      {at && (
        <PopupMenu
          x={at.x}
          y={at.y}
          items={items}
          onClose={() => setAt(null)}
          minWidth={168}
          zIndex={100100}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ dialog */

const CASING: Array<{ id: BatchRenameOptions["casing"]; label: string }> = [
  { id: "keep", label: "保持不变" },
  { id: "lower", label: "全部小写" },
  { id: "upper", label: "全部大写" },
  { id: "title", label: "每个单词首字母大写" },
  { id: "kebab", label: "空格换成短横线" },
  { id: "snake", label: "空格换成下划线" },
];

const NUMBER_FIELDS = [
  { key: "start", label: "起始", min: 0, max: 9999 },
  { key: "step", label: "步长", min: 0, max: 9999 },
  { key: "digits", label: "位数", min: 1, max: 6 },
] as const;

export function BatchRenameDialog() {
  const dialog = useExplorer((state) => state.dialog);
  const entries = useExplorer((state) => state.entries);
  const closeDialog = useExplorer((state) => state.closeDialog);
  const batchRename = useExplorer((state) => state.batchRename);

  const [options, setOptions] = useState<BatchRenameOptions>(DEFAULT_BATCH_RENAME);
  const [busy, setBusy] = useState(false);

  const open = dialog?.kind === "batch-rename";
  const paths = open ? dialog.paths : [];

  useEffect(() => {
    if (open) {
      setOptions(DEFAULT_BATCH_RENAME);
      setBusy(false);
    }
  }, [open, paths.length]);

  const targets = useMemo(() => {
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    return paths
      .map((path) => byPath.get(path))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  }, [entries, paths]);

  const plan = useMemo(
    () => planBatchRename(targets, options, entries.map((entry) => entry.name)),
    [targets, options, entries],
  );

  if (!open) return null;

  const patch = (next: Partial<BatchRenameOptions>) =>
    setOptions((current) => ({ ...current, ...next }));

  const canApply = plan.changed > 0 && plan.conflicts === 0 && !busy;

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    const ok = await batchRename(toRequestItems(plan));
    setBusy(false);
    if (ok) closeDialog();
  };

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
    >
      <Modal.Container placement="center" size="lg">
        <Modal.Dialog className="flex! h-[min(640px,calc(100vh-140px))] max-w-[900px] flex-col overflow-hidden">
          <Modal.Header>
            <Modal.Heading className="flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-[7px] bg-mac-blue/15 text-mac-blue">
                <Pencil className="size-3.5" />
              </span>
              批量重命名
              <span className="text-[11px] font-normal tabular-nums text-mac-muted">
                {targets.length} 个项目
              </span>
            </Modal.Heading>
          </Modal.Header>

          <Modal.Body className="grid min-h-0 flex-1 grid-cols-[324px_minmax(0,1fr)] gap-3 overflow-hidden">
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pb-1 pr-0.5">
              <Group label="查找与替换">
                <Row label="查找">
                  <input
                    aria-label="查找"
                    placeholder="要替换的文字"
                    className={FIELD_CLASS}
                    value={options.find}
                    onChange={(event) => patch({ find: event.target.value })}
                  />
                </Row>
                <Row label="替换">
                  <input
                    aria-label="替换为"
                    placeholder="留空即删除"
                    className={FIELD_CLASS}
                    value={options.replace}
                    onChange={(event) => patch({ replace: event.target.value })}
                  />
                </Row>
                <Row label="选项">
                  <div className="flex items-center gap-4 pl-0.5">
                      <Checkbox
                      label="区分大小写"
                      checked={options.caseSensitive}
                      onChange={(value) => patch({ caseSensitive: value })}
                    />
                    <Checkbox
                      label="正则"
                      checked={options.useRegex}
                      onChange={(value) => patch({ useRegex: value })}
                    />
                  </div>
                </Row>
              </Group>

              <Group label="编号">
                <Row label="位置">
                  <Segmented
                    label="编号位置"
                    value={options.numbering ? options.numberPosition : "off"}
                    onChange={(next) => {
                      if (next === "off") patch({ numbering: false });
                      else
                        patch({
                          numbering: true,
                          numberPosition: next as "prefix" | "suffix",
                        });
                    }}
                    options={[
                      { id: "off", label: "关闭" },
                      { id: "prefix", label: "前缀" },
                      { id: "suffix", label: "后缀" },
                    ]}
                  />
                </Row>
                <Row label="参数">
                  {NUMBER_FIELDS.map((field) => (
                    <label
                      key={field.key}
                      className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-[6px] bg-mac-surface pl-1.5 pr-1 shadow-[0_0_0_1px_var(--color-mac-line)] focus-within:shadow-[0_0_0_1px_var(--color-mac-blue),0_0_0_3px_var(--color-mac-blue-soft)]"
                    >
                      <span className="shrink-0 text-[10.5px] text-mac-muted">{field.label}</span>
                      <input
                        type="number"
                        aria-label={field.label}
                        min={field.min}
                        max={field.max}
                        className="h-full w-full min-w-0 appearance-none bg-transparent text-right text-[12px] tabular-nums text-mac-text outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        value={options[field.key]}
                        onChange={(event) =>
                          patch({
                            [field.key]: Math.max(
                              field.min,
                              Math.min(field.max, Number(event.target.value) || 0),
                            ),
                          } as Partial<BatchRenameOptions>)
                        }
                      />
                    </label>
                  ))}
                </Row>
              </Group>

              <Group label="添加文本">
                <Row label="文本">
                  <input
                    aria-label="添加文本"
                    placeholder="例如 终稿、_备份"
                    className={FIELD_CLASS}
                    value={options.affix}
                    onChange={(event) => patch({ affix: event.target.value })}
                  />
                </Row>
                <Row label="位置">
                  <Segmented
                    label="文本位置"
                    value={options.affixPosition}
                    onChange={(value) => patch({ affixPosition: value })}
                    options={[
                      { id: "prefix", label: "加在名称前" },
                      { id: "suffix", label: "加在名称后" },
                    ]}
                  />
                </Row>
              </Group>

              <Group label="大小写">
                <Row label="转换">
                  <Popup
                    label="大小写"
                    value={options.casing}
                    onChange={(value) => patch({ casing: value })}
                    options={CASING}
                  />
                </Row>
                <Row label="扩展名">
                  <Checkbox
                    label="一并修改"
                    checked={options.includeExtension}
                    onChange={(value) => patch({ includeExtension: value })}
                  />
                </Row>
              </Group>
            </div>

            <div className="flex min-h-0 flex-col overflow-hidden rounded-[10px] bg-mac-surface shadow-[0_0_0_1px_var(--color-mac-line)]">
              <div className="flex items-center gap-2 border-b border-mac-line px-3 py-1.5 text-[11px] font-medium text-mac-muted">
                <span className="flex-1">原名称</span>
                <span className="flex-1">新名称</span>
                <span className="size-3.5 shrink-0" />
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {plan.rows.map((row) => (
                  <div
                    key={row.entry.path}
                    className={`flex items-center gap-2 border-b border-mac-line px-3 py-1.5 text-[11.5px] last:border-b-0 ${
                      row.problem ? "bg-red-500/[0.06]" : ""
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-mac-muted">{row.name}</span>
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        row.problem
                          ? "font-medium text-red-600 dark:text-red-400"
                          : row.changed
                            ? "font-medium text-mac-text"
                            : "text-mac-muted"
                      }`}
                      title={row.next}
                    >
                      {row.next}
                    </span>
                    <span className="grid size-3.5 shrink-0 place-items-center">
                      {row.problem && (
                        <AlertTriangle
                          className="size-3.5 text-red-600 dark:text-red-400"
                          aria-label={row.problem}
                        />
                      )}
                    </span>
                  </div>
                ))}
              </div>
              {plan.patternError && (
                <div className="flex items-center gap-1.5 border-t border-mac-line px-3 py-1.5 text-[11px] text-red-600 dark:text-red-400">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  正则表达式无法解析：{plan.patternError}
                </div>
              )}
              {plan.conflicts > 0 && !plan.patternError && (
                <div className="flex items-center gap-1.5 border-t border-mac-line px-3 py-1.5 text-[11px] text-red-600 dark:text-red-400">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  {plan.conflicts} 项存在冲突，改正后才能应用
                </div>
              )}
            </div>
          </Modal.Body>

          <Modal.Footer>
            <Button variant="ghost" onPress={closeDialog}>
              取消
            </Button>
            <span className="flex-1" />
            <span className="text-[11px] tabular-nums text-mac-muted">
              {plan.changed} 项将重命名
            </span>
            <Button isPending={busy} isDisabled={!canApply} onPress={() => void apply()}>
              应用
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
