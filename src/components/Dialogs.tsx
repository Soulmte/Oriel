import { useEffect, useState } from "react";
import { Button, Input, Modal } from "@heroui/react";
import type { ConflictPolicy } from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { basename } from "../lib/format";

/** macOS alert shape: a small sheet, a centred title, buttons bottom-right. */
const DIALOG = "w-[380px] max-w-[380px] gap-0! rounded-[12px] p-0!";
const HEADER = "justify-center px-5 pb-0 pt-4";
const HEADING = "text-center text-[13px] font-semibold text-mac-text";
const BODY = "px-5 pb-0 pt-2.5";
const FOOTER = "flex-nowrap justify-end gap-2 px-5 pb-4 pt-4";

const BUTTON = "h-7 min-w-[72px] rounded-[6px] px-3 text-[12.5px] font-normal";
const PRIMARY = `${BUTTON} bg-mac-blue text-white data-[hovered=true]:bg-mac-blue/90`;
const SECONDARY = `${BUTTON} bg-mac-surface text-mac-text shadow-[0_0_0_1px_var(--color-mac-line)] data-[hovered=true]:bg-black/[0.04] dark:data-[hovered=true]:bg-white/[0.08]`;
const DESTRUCTIVE = `${BUTTON} bg-[#ff3b30] text-white data-[hovered=true]:bg-[#ff3b30]/90`;
const DANGER_TEXT = "text-red-600 dark:text-red-400";

/** Text field in the alert, same language as the settings fields. */
const INPUT =
  "h-7 rounded-[6px] bg-mac-surface px-2 text-[12.5px] text-mac-text " +
  "shadow-[0_0_0_1px_var(--color-mac-line)] outline-none transition-[box-shadow] duration-100 " +
  "focus:shadow-[0_0_0_1px_var(--color-mac-blue),0_0_0_3px_var(--color-mac-blue-soft)]";

export function Dialogs() {
  const dialog = useExplorer((state) => state.dialog);
  const closeDialog = useExplorer((state) => state.closeDialog);
  const createFolder = useExplorer((state) => state.createFolder);
  const createFile = useExplorer((state) => state.createFile);
  const renameEntry = useExplorer((state) => state.renameEntry);
  const submitTransfer = useExplorer((state) => state.submitTransfer);
  const performRemove = useExplorer((state) => state.performRemove);
  const purgeRecycle = useExplorer((state) => state.purgeRecycle);
  const emptyRecycle = useExplorer((state) => state.emptyRecycle);

  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (dialog?.kind === "new-folder") {
      setValue("未命名文件夹");
    } else if (dialog?.kind === "new-file") {
      setValue(`${dialog.suggested ?? `新建${dialog.label}`}.${dialog.extension}`);
    } else if (dialog?.kind === "rename") {
      setValue(dialog.entry.name);
    } else {
      setValue("");
    }
    setBusy(false);
  }, [dialog]);

  // The batch rename dialog is its own modal; keeping this one closed avoids
  // two backdrops fighting over the focus trap.
  const isOpen = dialog !== null && dialog.kind !== "batch-rename";
  const errorDialog = dialog?.kind === "error" ? dialog : null;
  const conflictDialog = dialog?.kind === "conflict" ? dialog : null;
  const removeDialog = dialog?.kind === "confirm-remove" ? dialog : null;
  const purgeDialog = dialog?.kind === "confirm-purge" ? dialog : null;

  const submit = async () => {
    if (!dialog || busy) return;
    if (
      dialog.kind === "error" ||
      dialog.kind === "conflict" ||
      dialog.kind === "confirm-remove" ||
      dialog.kind === "confirm-purge"
    ) {
      return;
    }

    const trimmed = value.trim();
    if (!trimmed) return;

    setBusy(true);
    const ok =
      dialog.kind === "new-folder"
        ? await createFolder(trimmed)
        : dialog.kind === "new-file"
          ? await createFile(trimmed, dialog.content, dialog.template)
          : await renameEntry(trimmed);
    setBusy(false);

    if (ok) closeDialog();
  };

  const resolveConflict = async (policy: ConflictPolicy) => {
    if (!conflictDialog) return;
    const { action, sources, target } = conflictDialog;
    closeDialog();
    await submitTransfer(action, sources, target, policy);
  };

  const isDelete = Boolean(purgeDialog || removeDialog);

  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
    >
      <Modal.Container placement="center">
        <Modal.Dialog className={DIALOG}>
          {errorDialog ? (
            <>
              <Modal.Header className={HEADER}>
                <Modal.Heading className={HEADING}>操作失败</Modal.Heading>
              </Modal.Header>
              <Modal.Body className={BODY}>
                <p className="select-text text-[12px] leading-5 text-mac-muted">
                  {errorDialog.message}
                </p>
              </Modal.Body>
              <Modal.Footer className={FOOTER}>
                <Button className={PRIMARY} onPress={closeDialog}>
                  好
                </Button>
              </Modal.Footer>
            </>
          ) : conflictDialog ? (
            <>
              <Modal.Header className={HEADER}>
                <Modal.Heading className={HEADING}>发现同名项目</Modal.Heading>
              </Modal.Header>

              <Modal.Body className={BODY}>
                <p className="text-[12px] leading-5 text-mac-muted">
                  目标位置已有 {conflictDialog.conflicts.length} 个同名项目
                </p>
                <ul className="mt-2 max-h-[116px] space-y-0.5 overflow-y-auto rounded-[8px] bg-black/[0.04] px-2.5 py-1.5 text-[12px] dark:bg-white/[0.06]">
                  {conflictDialog.conflicts.slice(0, 6).map((item) => (
                    <li key={item.destination} className="truncate text-mac-text">
                      {basename(item.destination)}
                    </li>
                  ))}
                  {conflictDialog.conflicts.length > 6 && (
                    <li className="text-mac-muted">
                      …以及另外 {conflictDialog.conflicts.length - 6} 个
                    </li>
                  )}
                </ul>
                <p className="mt-2 text-[11px] leading-4 text-mac-muted/80">
                  「替换」会删除已有的同名项目，无法撤销
                </p>
              </Modal.Body>

              <Modal.Footer className={FOOTER}>
                <Button className={SECONDARY} onPress={closeDialog}>
                  取消
                </Button>
                <Button className={SECONDARY} onPress={() => void resolveConflict("skip")}>
                  跳过
                </Button>
                <Button className={DANGER_TEXT + " bg-transparent shadow-none"} onPress={() => void resolveConflict("overwrite")}>
                  替换
                </Button>
                <Button className={PRIMARY} onPress={() => void resolveConflict("rename")}>
                  保留两者
                </Button>
              </Modal.Footer>
            </>
          ) : purgeDialog ? (
            <>
              <Modal.Header className={HEADER}>
                <Modal.Heading className={HEADING}>
                  {purgeDialog.all ? "清空废纸篓？" : "永久删除？"}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className={BODY}>
                <p className="text-center text-[12px] leading-5 text-mac-muted">
                  {purgeDialog.all
                    ? "将永久删除废纸篓中的所有项目，此操作无法撤销"
                    : `将永久删除 ${purgeDialog.ids.length} 个项目，此操作无法撤销`}
                </p>
              </Modal.Body>
              <Modal.Footer className={FOOTER}>
                <Button className={SECONDARY} onPress={closeDialog}>
                  取消
                </Button>
                <Button
                  className={DESTRUCTIVE}
                  onPress={() => {
                    const { ids, all } = purgeDialog;
                    closeDialog();
                    if (all) void emptyRecycle();
                    else void purgeRecycle(ids);
                  }}
                >
                  {purgeDialog.all ? "清空" : "永久删除"}
                </Button>
              </Modal.Footer>
            </>
          ) : removeDialog ? (
            <>
              <Modal.Header className={HEADER}>
                <Modal.Heading className={HEADING}>永久删除？</Modal.Heading>
              </Modal.Header>
              <Modal.Body className={BODY}>
                <p className="text-center text-[12px] leading-5 text-mac-muted">
                  将永久删除 {removeDialog.paths.length} 个项目，文件不会进入废纸篓，也无法撤销
                </p>
                <ul className="mt-2 max-h-[116px] space-y-0.5 overflow-y-auto rounded-[8px] bg-black/[0.04] px-2.5 py-1.5 text-[12px] dark:bg-white/[0.06]">
                  {removeDialog.paths.slice(0, 6).map((item) => (
                    <li key={item} className="truncate text-mac-text">
                      {basename(item) || item}
                    </li>
                  ))}
                  {removeDialog.paths.length > 6 && (
                    <li className="text-mac-muted">
                      …以及另外 {removeDialog.paths.length - 6} 个
                    </li>
                  )}
                </ul>
              </Modal.Body>
              <Modal.Footer className={FOOTER}>
                <Button className={SECONDARY} onPress={closeDialog}>
                  取消
                </Button>
                <Button
                  className={DESTRUCTIVE}
                  onPress={() => {
                    const paths = [...removeDialog.paths];
                    closeDialog();
                    void performRemove(paths, true);
                  }}
                >
                  永久删除
                </Button>
              </Modal.Footer>
            </>
          ) : (
            <>
              <Modal.Header className={HEADER}>
                <Modal.Heading className={HEADING}>
                  {dialog?.kind === "rename"
                    ? "重命名"
                    : dialog?.kind === "new-file"
                      ? `新建${dialog.label}`
                      : "新建文件夹"}
                </Modal.Heading>
              </Modal.Header>

              <Modal.Body className={BODY}>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <Input
                    id="entry-name"
                    aria-label="名称"
                    autoFocus
                    fullWidth
                    variant="secondary"
                    className={INPUT}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onFocus={(event) => {
                      const input = event.currentTarget;
                      const dot = input.value.lastIndexOf(".");
                      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submit();
                      }
                      if (event.key === "Escape") closeDialog();
                    }}
                  />
                </form>
              </Modal.Body>

              <Modal.Footer className={FOOTER}>
                <Button className={SECONDARY} onPress={closeDialog}>
                  取消
                </Button>
                <Button
                  className={PRIMARY}
                  isPending={busy}
                  isDisabled={!value.trim()}
                  onPress={() => void submit()}
                >
                  {dialog?.kind === "rename" ? "重命名" : "创建"}
                </Button>
              </Modal.Footer>
            </>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
