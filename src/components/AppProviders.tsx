import type { ReactNode } from "react";
import { ThemeProvider } from "./ThemeProvider";

/**
 * Global UI providers. HeroUI v3 has no theme provider of its own, but the
 * app needs one place that owns the theme and the toast queue.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      {children}
    </ThemeProvider>
  );
}
