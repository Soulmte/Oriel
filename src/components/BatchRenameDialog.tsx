import { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { AlertTriangle, Hash, Pencil, Replace, Type } from "lucide-react";
import { useExplorer } from "../store/explorer";
import {
  DEFAULT_BATCH_RENAME,
  planBatchRename,
  toRequestItems,
} from "../lib/batchRename";
import type { BatchRenameOptions } from "../lib/batchRename";

const FIELD =
  "h-7 w-full rounded-md border border-black/10 bg-black/[0.03] px-2 text-[12px] text-mac-text outline-none focus:border-mac-blue/60 dark:border-white/15 dark:bg-white/[0.06]";
const LABEL = "text-[11px] font-medium text-mac-muted";
const SEGMENT =
  "rounded-md px-2 py-0.5 text-[11px] data-[selected=true]:bg-mac-surface data-[selected=true]:shadow-sm";

const CASING: Array<{ id: BatchRenameOptions["casing"]; label: string }> = [
  { id: "keep", label: "保持" },
  { id: "lower", label: "小写" },
  { id: "upper", label: "大写" },
  { id: "title", label: "首字母大写" },
  { id: "kebab", label: "短横线" },
  { id: "snake", label: "下划线" },
];

function Row({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5 rounded-lg border border-mac-line/70 bg-mac-chrome/40 p-2">
      <div className="flex items-center gap-1.5">
        <span className="text-mac-muted">{icon}</span>
        <span className="text-[11px] font-semibold text-mac-text">{title}</span>
      </div>
      {children}
    </section>
  );
}

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
    <Modal.Backdrop isOpen onOpenChange={(next) => { if (!next) closeDialog(); }}>
      <Modal.Container placement="center" size="lg">
        <Modal.Dialog className="flex! h-[min(660px,calc(100vh-140px))] max-w-[900px] flex-col overflow-hidden">
          <Modal.Header>
            <Modal.Heading className="flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-md bg-mac-blue/15 text-mac-blue">
                <Pencil className="size-3.5" />
              </span>
              批量重命名
              <span className="text-[11px] font-normal text-mac-muted">
                {targets.length} 个项目
              </span>
            </Modal.Heading>
          </Modal.Header>

          <Modal.Body className="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)] gap-3 overflow-hidden">
            <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto pr-1">
              <Row icon={<Replace className="size-3.5" />} title="查找与替换">
                <div className="grid grid-cols-2 gap-1.5">
                  <Input
                    aria-label="查找"
                    placeholder="查找"
                    variant="secondary"
                    className="h-7 text-[12px]"
                    value={options.find}
                    onChange={(event) => patch({ find: event.target.value })}
                  />
                  <Input
                    aria-label="替换为"
                    placeholder="替换为（留空删除）"
                    variant="secondary"
                    className="h-7 text-[12px]"
                    value={options.replace}
                    onChange={(event) => patch({ replace: event.target.value })}
                  />
                </div>
                <ToggleButtonGroup
                  aria-label="查找选项"
                  selectionMode="multiple"
                  size="sm"
                  className="mt-0.5 self-start rounded-lg border border-mac-line bg-mac-chrome p-0.5"
                  selectedKeys={[
                    ...(options.caseSensitive ? ["case"] : []),
                    ...(options.useRegex ? ["regex"] : []),
                  ]}
                  onSelectionChange={(keys) => {
                    const set = new Set(Array.from(keys, String));
                    patch({ caseSensitive: set.has("case"), useRegex: set.has("regex") });
                  }}
                >
                  <ToggleButton id="case" className={SEGMENT}>
                    区分大小写
                  </ToggleButton>
                  <ToggleButton id="regex" className={SEGMENT}>
                    正则
                  </ToggleButton>
                </ToggleButtonGroup>
              </Row>

              <Row icon={<Hash className="size-3.5" />} title="编号">
                <div className="flex items-center gap-1.5">
                  <ToggleButtonGroup
                    aria-label="编号位置"
                    selectionMode="single"
                    disallowEmptySelection
                    size="sm"
                    className="rounded-lg border border-mac-line bg-mac-chrome p-0.5"
                    selectedKeys={[options.numbering ? options.numberPosition : "off"]}
                    onSelectionChange={(keys) => {
                      const next = String(Array.from(keys)[0]);
                      if (next === "off") patch({ numbering: false });
                      else patch({ numbering: true, numberPosition: next as "prefix" | "suffix" });
                    }}
                  >
                    <ToggleButton id="off" className={SEGMENT}>
                      关闭
                    </ToggleButton>
                    <ToggleButton id="prefix" className={SEGMENT}>
                      前缀
                    </ToggleButton>
                    <ToggleButton id="suffix" className={SEGMENT}>
                      后缀
                    </ToggleButton>
                  </ToggleButtonGroup>
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {(
                    [
                      ["起始", "start"],
                      ["步长", "step"],
                      ["位数", "digits"],
                    ] as const
                  ).map(([label, key]) => (
                    <label key={key} className="flex flex-col gap-0.5">
                      <span className={LABEL}>{label}</span>
                      <input
                        type="number"
                        min={key === "digits" ? 1 : 0}
                        max={key === "digits" ? 6 : 9999}
                        className={FIELD}
                        value={options[key]}
                        onChange={(event) =>
                          patch({
                            [key]: Math.max(
                              key === "digits" ? 1 : 0,
                              Math.min(
                                key === "digits" ? 6 : 9999,
                                Number(event.target.value) || 0,
                              ),
                            ),
                          } as Partial<BatchRenameOptions>)
                        }
                      />
                    </label>
                  ))}
                </div>
              </Row>

              <Row icon={<Type className="size-3.5" />} title="添加文本">
                <Input
                  aria-label="添加文本"
                  placeholder="例如 终稿、_备份"
                  variant="secondary"
                  className="h-7 text-[12px]"
                  value={options.affix}
                  onChange={(event) => patch({ affix: event.target.value })}
                />
                <ToggleButtonGroup
                  aria-label="文本位置"
                  selectionMode="single"
                  disallowEmptySelection
                  size="sm"
                  className="self-start rounded-lg border border-mac-line bg-mac-chrome p-0.5"
                  selectedKeys={[options.affixPosition]}
                  onSelectionChange={(keys) =>
                    patch({ affixPosition: String(Array.from(keys)[0]) as "prefix" | "suffix" })
                  }
                >
                  <ToggleButton id="prefix" className={SEGMENT}>
                    加在名称前
                  </ToggleButton>
                  <ToggleButton id="suffix" className={SEGMENT}>
                    加在名称后
                  </ToggleButton>
                </ToggleButtonGroup>
              </Row>

              <Row icon={<Type className="size-3.5" />} title="大小写">
                <ToggleButtonGroup
                  aria-label="大小写"
                  selectionMode="single"
                  disallowEmptySelection
                  size="sm"
                  className="grid grid-cols-3 gap-0.5 rounded-lg border border-mac-line bg-mac-chrome p-0.5"
                  selectedKeys={[options.casing]}
                  onSelectionChange={(keys) =>
                    patch({ casing: String(Array.from(keys)[0]) as BatchRenameOptions["casing"] })
                  }
                >
                  {CASING.map((item) => (
                    <ToggleButton
                      key={item.id}
                      id={item.id}
                      className="justify-center rounded-md px-1 py-0.5 text-[11px] data-[selected=true]:bg-mac-surface data-[selected=true]:shadow-sm"
                    >
                      {item.label}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
                <label className="mt-0.5 flex items-center gap-1.5 text-[11px] text-mac-muted">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[var(--mac-blue,#0a84ff)]"
                    checked={options.includeExtension}
                    onChange={(event) => patch({ includeExtension: event.target.checked })}
                  />
                  连扩展名一起改
                </label>
              </Row>
            </div>

            <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-mac-line/70">
              <div className="flex items-center gap-2 border-b border-mac-line/70 bg-mac-chrome/60 px-2.5 py-1.5 text-[11px] font-medium text-mac-muted">
                <span className="flex-1">原名称</span>
                <span className="flex-1">新名称</span>
                <span className="w-16 text-right">状态</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {plan.rows.map((row) => (
                  <div
                    key={row.entry.path}
                    className={
                      row.problem
                        ? "flex items-center gap-2 border-b border-mac-line/40 bg-red-500/[0.06] px-2.5 py-1 text-[11.5px]"
                        : "flex items-center gap-2 border-b border-mac-line/40 px-2.5 py-1 text-[11.5px]"
                    }
                  >
                    <span className="min-w-0 flex-1 truncate text-mac-muted line-through decoration-mac-line">
                      {row.name}
                    </span>
                    <span
                      className={
                        row.problem
                          ? "min-w-0 flex-1 truncate font-medium text-red-600 dark:text-red-400"
                          : row.changed
                            ? "min-w-0 flex-1 truncate font-medium text-mac-text"
                            : "min-w-0 flex-1 truncate text-mac-muted"
                      }
                      title={row.next}
                    >
                      {row.next}
                    </span>
                    <span className="w-16 shrink-0 text-right text-[10.5px] text-mac-muted">
                      {row.problem ? (
                        <span className="text-red-600 dark:text-red-400">冲突</span>
                      ) : row.changed ? (
                        "将修改"
                      ) : (
                        "不变"
                      )}
                    </span>
                  </div>
                ))}
              </div>
              {plan.patternError && (
                <div className="flex items-center gap-1.5 border-t border-mac-line/70 px-2.5 py-1.5 text-[11px] text-red-600 dark:text-red-400">
                  <AlertTriangle className="size-3.5" />
                  正则表达式无法解析：{plan.patternError}
                </div>
              )}
              {plan.conflicts > 0 && !plan.patternError && (
                <div className="flex items-center gap-1.5 border-t border-mac-line/70 px-2.5 py-1.5 text-[11px] text-red-600 dark:text-red-400">
                  <AlertTriangle className="size-3.5" />
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
            <span className="text-[11px] text-mac-muted">
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
