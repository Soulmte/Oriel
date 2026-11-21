export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export async function minimizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await (await currentWindow()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri()) return;
  await (await currentWindow()).toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  if (!isTauri()) return;
  await (await currentWindow()).close();
}

export async function isMaximized(): Promise<boolean> {
  if (!isTauri()) return false;
  return (await currentWindow()).isMaximized();
}
