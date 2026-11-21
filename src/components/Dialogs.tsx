import { useEffect, useState } from "react";
import { AlertTriangle, CopyX, FilePlus, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { Button, Input, Label, Modal } from "@heroui/react";
import type { ConflictPolicy } from "@oriel/shared";
import { useExplorer } from "../store/explorer";
import { basename } from "../lib/format";

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
      setValue(`新建 ${dialog.label}.${dialog.extension}`);
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
          ? await createFile(trimmed, dialog.content)
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

  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) closeDialog();
      }}
    >
      <Modal.Container placement="center">
        <Modal.Dialog className="sm:max-w-[440px]">
          {errorDialog ? (
            <>
              <Modal.Header>
                <Modal.Icon className="bg-[#ff9f0a]/15 text-[#ff9f0a]">
                  <AlertTriangle className="size-5" />
                </Modal.Icon>
                <Modal.Heading>操作失败</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="select-text text-[13px] leading-6 text-mac-muted">
                  {errorDialog.message}
                </p>
              </Modal.Body>
              <Modal.Footer>
                <Button onPress={closeDialog}>好</Button>
              </Modal.Footer>
            </>
          ) : conflictDialog ? (
            <>
              <Modal.Header>
                <Modal.Icon className="bg-[#ff9f0a]/15 text-[#ff9f0a]">
                  <CopyX className="size-5" />
                </Modal.Icon>
                <Modal.Heading>发现同名项目</Modal.Heading>
              </Modal.Header>

              <Modal.Body>
                <p className="text-[13px] leading-6 text-mac-muted">
                  目标位置已有 {conflictDialog.conflicts.length} 个同名项目，选择处理方式：
                </p>
                <ul className="mt-2.5 max-h-[120px] space-y-0.5 overflow-y-auto rounded-lg bg-black/[0.04] px-2.5 py-1.5 text-[12px] dark:bg-white/[0.05]">
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
                <p className="mt-2.5 text-[11px] leading-5 text-mac-muted/80">
                  「替换」会删除已有的同名项目，无法撤销。
                </p>
              </Modal.Body>

              <Modal.Footer className="flex-nowrap">
                <Button variant="ghost" onPress={closeDialog}>
                  取消
                </Button>
                <span className="flex-1" />
                <Button variant="tertiary" onPress={() => void resolveConflict("skip")}>
                  跳过
                </Button>
                <Button
                  variant="danger-soft"
                  onPress={() => void resolveConflict("overwrite")}
                >
                  替换
                </Button>
                <Button onPress={() => void resolveConflict("rename")}>保留两者</Button>
              </Modal.Footer>
            </>
          ) : purgeDialog ? (
            <>
              <Modal.Header>
                <Modal.Icon className="bg-[#ff3b30]/15 text-[#ff3b30]">
                  <Trash2 className="size-5" />
                </Modal.Icon>
                <Modal.Heading>
                  {purgeDialog.all ? "清空废纸篓？" : "永久删除？"}
                </Modal.Heading>
              </Modal.Header>

              <Modal.Body>
                <p className="text-[13px] leading-6 text-mac-muted">
                  {purgeDialog.all
                    ? "将永久删除废纸篓中的所有项目，此操作无法撤销。"
                    : `将永久删除 ${purgeDialog.ids.length} 个项目，此操作无法撤销。`}
                </p>
              </Modal.Body>

              <Modal.Footer>
                <Button variant="ghost" onPress={closeDialog}>
                  取消
                </Button>
                <span className="flex-1" />
                <Button
                  variant="danger-soft"
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
              <Modal.Header>
                <Modal.Icon className="bg-[#ff3b30]/15 text-[#ff3b30]">
                  <Trash2 className="size-5" />
                </Modal.Icon>
                <Modal.Heading>永久删除？</Modal.Heading>
              </Modal.Header>

              <Modal.Body>
                <p className="text-[13px] leading-6 text-mac-muted">
                  将永久删除 {removeDialog.paths.length} 个项目，文件不会进入废纸篓，也无法撤销。
                </p>
                <ul className="mt-2.5 max-h-[120px] space-y-0.5 overflow-y-auto rounded-lg bg-black/[0.04] px-2.5 py-1.5 text-[12px] dark:bg-white/[0.05]">
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

              <Modal.Footer>
                <Button variant="ghost" onPress={closeDialog}>
                  取消
                </Button>
                <span className="flex-1" />
                <Button
                  variant="danger-soft"
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
              <Modal.Header>
                <Modal.Icon className="bg-mac-blue/15 text-mac-blue">
                  {dialog?.kind === "rename" ? (
                    <Pencil className="size-5" />
                  ) : dialog?.kind === "new-file" ? (
                    <FilePlus className="size-5" />
                  ) : (
                    <FolderPlus className="size-5" />
                  )}
                </Modal.Icon>
                <Modal.Heading>
                  {dialog?.kind === "rename"
                    ? "重命名"
                    : dialog?.kind === "new-file"
                      ? `新建${dialog.label}`
                      : "新建文件夹"}
                </Modal.Heading>
              </Modal.Header>

              <Modal.Body>
                <form
                  className="flex flex-col gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <Label htmlFor="entry-name" className="text-[12px] font-medium text-mac-muted">
                    名称
                  </Label>
                  <Input
                    id="entry-name"
                    aria-label="名称"
                    autoFocus
                    fullWidth
                    variant="secondary"
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

              <Modal.Footer>
                <Button variant="ghost" onPress={closeDialog}>
                  取消
                </Button>
                <Button
                  isPending={busy}
                  isDisabled={!value.trim()}
                  onPress={() => void submit()}
                >
                  确定
                </Button>
              </Modal.Footer>
            </>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
