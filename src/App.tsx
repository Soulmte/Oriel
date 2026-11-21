import { useEffect } from "react";
import { useExplorer } from "./store/explorer";
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
import { SettingsPage } from "./components/SettingsPage";
import { RecycleBin } from "./components/RecycleBin";
import { OperationsPanel } from "./components/OperationsPanel";

function ExplorerShell() {
  const init = useExplorer((state) => state.init);
  const route = useExplorer((state) => state.route);

  useEffect(() => {
    void init();
  }, [init]);

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
        <main className="flex min-w-0 flex-1 flex-col bg-mac-surface">
          {route === "settings" ? (
            <SettingsPage />
          ) : route === "recycle" ? (
            <RecycleBin />
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
