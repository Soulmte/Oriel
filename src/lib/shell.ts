/**
 * Native shell bridge.
 *
 * In the Tauri window a few things are better done by Windows itself: the
 * properties dialog (security/permissions/details) and `IFileOperation` deletes
 * that land in the real recycle bin with an undo record. In a plain browser none
 * of that exists, so every helper reports "not handled" and the caller falls
 * back to the REST service.
 */

export function isNativeShellAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeCommand<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/**
 * Shell context-menu APIs are serialized: third-party shell extensions are not
 * required to be thread-safe, and two overlapping probes have been observed to
 * corrupt the process heap. One call at a time keeps the COM side predictable.
 */
let menuQueue: Promise<unknown> = Promise.resolve();

function enqueueMenuTask<T>(task: () => Promise<T>): Promise<T> {
  const run = menuQueue.then(task, task);
  menuQueue = run.catch(() => undefined);
  return run;
}

/** Opens the standard Windows properties dialog. */
export async function showSystemProperties(path: string): Promise<boolean> {
  if (!isNativeShellAvailable()) return false;
  await invokeCommand("open_properties", { path });
  return true;
}

/** Deletes through the shell; `permanent = false` uses the recycle bin. */
export async function shellDelete(
  paths: string[],
  permanent: boolean,
): Promise<boolean> {
  if (!isNativeShellAvailable()) return false;
  await invokeCommand("shell_delete", { paths, permanent });
  return true;
}

export interface ShellVerb {
  id: number;
  label: string;
  /** Opens a nested menu (7-Zip, 发送到, 打开方式…). */
  submenu: boolean;
  /** Entries of that nested menu. */
  children: ShellVerb[];
}

/** Shell verbs the OS offers for this path (7-Zip, Send to, scan, share…). */
export async function listShellVerbs(path: string): Promise<ShellVerb[]> {
  if (!isNativeShellAvailable()) return [];
  return enqueueMenuTask(() => invokeCommand<ShellVerb[]>("shell_verbs", { path }));
}

/** Runs one of the verbs returned by `listShellVerbs`. */
export async function invokeShellVerb(path: string, id: number): Promise<void> {
  if (!isNativeShellAvailable()) return;
  await enqueueMenuTask(() => invokeCommand("shell_invoke_verb", { path, id }));
}

/**
 * Opens the real Windows context menu ("显示更多选项") for one entry. The call
 * resolves once the user closes the menu; the shell runs the chosen verb itself.
 */
export async function showShellContextMenu(path: string): Promise<boolean> {
  if (!isNativeShellAvailable()) return false;
  return enqueueMenuTask(() => invokeCommand<boolean>("shell_context_menu", { path }));
}

/** Moves through the shell (system progress, cross-volume aware). */
export async function shellMove(
  paths: string[],
  target: string,
): Promise<boolean> {
  if (!isNativeShellAvailable()) return false;
  await invokeCommand("shell_move", { paths, target });
  return true;
}
