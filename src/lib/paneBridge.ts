/**
 * Thin bridge between the global chrome (sidebar, menus) and the pane that
 * currently has focus. Split view keeps each pane's browsing state local, so
 * the sidebar cannot call the global `navigate`; it asks the active pane
 * through this tiny interface instead.
 */
export interface PaneApi {
  path(): string;
  navigate(target: string): void;
  refresh(): void;
}

export const paneBridge: { active: PaneApi | null } = { active: null };
