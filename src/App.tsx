import { useEffect } from "react";
import { useExplorer } from "./store/explorer";
import { isTauri } from "./lib/window";
import { useShortcuts } from "./hooks/useShortcuts";
import { useClipboardSync } from "./hooks/useClipboardSync";
import { useAppearanceEffects } from "./hooks/useAppearanceEffects";
import { AppProviders } from "./components/AppProviders";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { Breadcrumbs } from "./components/Breadcrumbs";
import { ContentArea } from "./components/ContentArea";
import { PreviewPanel } from "./components/PreviewPanel";
import { StatusBar } from "./components/StatusBar";
import { ContextMenuLayer } from "./components/ContextMenuLayer";
import { Dialogs } from "./components/Dialogs";
import { BatchRenameDialog } from "./components/BatchRenameDialog";
import { ToastHost } from "./components/ToastHost";
import { UpdatePopup } from "./components/UpdatePopup";
import { SettingsPage } from "./components/SettingsPage";
import { HomePage } from "./components/HomePage";
import { RecycleBin } from "./components/RecycleBin";
import { ProcessesPage } from "./components/ProcessesPage";
import { PortsPage } from "./components/PortsPage";
import { DiskCleanupPage } from "./components/DiskCleanupPage";
import { UninstallerPage } from "./components/UninstallerPage";
import { OperationsPanel } from "./components/OperationsPanel";
import { MultiPane } from "./components/multi/MultiPane";
import { SplitToolbar } from "./components/multi/SplitToolbar";

function ExplorerShell() {
  const init = useExplorer((state) => state.init);
  const route = useExplorer((state) => state.route);
  const layout = useExplorer((state) => state.layout);

  useEffect(() => {
    void init();
  }, [init]);

  // A second launch (desktop shortcut, folder handler) focuses the running
  // window in Rust; this event carries the folder that was passed in.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen<string>("oriel:open-path", (event) => {
        const target = event.payload?.trim();
        if (target) void useExplorer.getState().navigate(target);
      });
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea")) return;
      event.preventDefault();
    };
    window.addEventListener("contextmenu", handler);
    return () => window.removeEventListener("contextmenu", handler);
  }, []);

  useShortcuts();
  useClipboardSync();
  useAppearanceEffects();

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-mac-bg text-mac-text">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="relative flex min-w-0 flex-1 flex-col bg-mac-surface">
          {route === "home" ? (
            <HomePage />
          ) : route === "settings" ? (
            <SettingsPage />
          ) : route === "recycle" ? (
            <RecycleBin />
          ) : route === "processes" ? (
            <ProcessesPage />
          ) : route === "ports" ? (
            <PortsPage />
          ) : route === "cleanup" ? (
            <DiskCleanupPage />
          ) : route === "uninstaller" ? (
            <UninstallerPage />
          ) : layout !== "1" ? (
            <>
              <SplitToolbar />
              <MultiPane />
            </>
          ) : (
            <>
              <Toolbar />
              <Breadcrumbs />
              <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
                <ContentArea />
                <PreviewPanel />
              </div>
              <StatusBar />
            </>
          )}
        </main>
      </div>
      <OperationsPanel />
      <ContextMenuLayer />
      <Dialogs />
      <BatchRenameDialog />
      <ToastHost />
      <UpdatePopup />
    </div>
  );
}

export default function App() {
  return (
    <AppProviders>
      <ExplorerShell />
    </AppProviders>
  );
}
