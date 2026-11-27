import { isNativeShellAvailable } from "./shell";

/**
 * Desktop-only integration: autostart, tray, folder handler, command line.
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

/** Persisted by Rust, so it can be applied before the webview exists. */
export interface ShellPrefs {
  tray: boolean;
  closeToTray: boolean;
  autostart: boolean;
  folderHandler: boolean;
  defaultHandler: boolean;
}

export async function readAutostart(): Promise<AutostartState> {
  if (!isNativeShellAvailable()) return { enabled: false, supported: false };
  try {
    return await invoke<AutostartState>("get_autostart");
  } catch {
    return { enabled: false, supported: false };
  }
}

export async function readShellPrefs(): Promise<ShellPrefs | null> {
  if (!isNativeShellAvailable()) return null;
  try {
    return await invoke<ShellPrefs>("get_shell_prefs");
  } catch {
    return null;
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
  if (!isNativeShellAvailable()) return enabled;
  return invoke<boolean>("set_folder_handler", { enabled });
}

/** Takes over the shell's folder-open verb for the current user. */
export async function writeDefaultHandler(enabled: boolean): Promise<boolean> {
  if (!isNativeShellAvailable()) return enabled;
  return invoke<boolean>("set_default_file_manager", { enabled });
}

export async function openLogFolder(): Promise<void> {
  if (!isNativeShellAvailable()) return;
  await invoke("open_log_folder");
}

/** Kills and restarts the bundled local service. */
export async function restartService(): Promise<void> {
  if (!isNativeShellAvailable()) return;
  await invoke("restart_service");
}

/**
 * Restarts Oriel through a UAC prompt. The current window closes first, then a
 * helper relaunches the exe elevated so system-level cleanup can proceed.
 */
export async function relaunchElevated(): Promise<void> {
  if (!isNativeShellAvailable()) return;
  await invoke("relaunch_elevated");
}

/** Folder paths passed on the command line by the shell integration. */
export async function takeStartupPaths(): Promise<string[]> {
  if (!isNativeShellAvailable()) return [];
  try {
    return await invoke<string[]>("take_startup_paths");
  } catch {
    return [];
  }
}

/**
 * Launches a downloaded installer and quits. The service restricts this to
 * files under `%TEMP%\oriel-updates`, so a bad update feed cannot run anything.
 */
export async function installUpdate(path: string): Promise<void> {
  if (!isNativeShellAvailable()) return;
  await invoke("install_update", { path });
}
