import { isNativeShellAvailable } from "./shell";

/**
 * Desktop-only integration: autostart, tray, folder handler.
 *
 * Everything here is a Tauri command, so in the browser build each helper
 * reports "unsupported" instead of pretending it worked.
 */

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke: call } = await import("@tauri-apps/api/core");
  return call<T>(command, args);
}

export interface AutostartState {
  enabled: boolean;
  supported: boolean;
}

export async function readAutostart(): Promise<AutostartState> {
  if (!isNativeShellAvailable()) return { enabled: false, supported: false };
  try {
    return await invoke<AutostartState>("get_autostart");
  } catch {
    return { enabled: false, supported: false };
  }
}

export async function writeAutostart(enabled: boolean): Promise<boolean> {
  if (!isNativeShellAvailable()) return false;
  return invoke<boolean>("set_autostart", { enabled });
}

export async function writeTrayVisible(visible: boolean): Promise<void> {
  if (!isNativeShellAvailable()) return;
  await invoke("set_tray_visible", { visible });
}

/** Closing the window hides it (true) or quits the app (false). */
export async function writeCloseBehavior(minimize: boolean): Promise<void> {
  if (!isNativeShellAvailable()) return;
  await invoke("set_close_behavior", { minimize });
}

/** Adds/removes "用 Oriel 打开" on folders, folders' background and drives. */
export async function writeFolderHandler(enabled: boolean): Promise<boolean> {
  if (!isNativeShellAvailable()) return false;
  return invoke<boolean>("set_folder_handler", { enabled });
}

export async function openDefaultAppsSettings(): Promise<void> {
  if (!isNativeShellAvailable()) return;
  await invoke("open_default_apps");
}
