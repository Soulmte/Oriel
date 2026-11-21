import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { useTheme } from "@heroui/react";

interface ThemeContextValue {
  theme: string;
  setTheme: (theme: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * One theme controller for the whole app. HeroUI stores the choice in
 * localStorage and applies the class/data-theme attributes to <html>.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const { theme, setTheme } = useTheme("system");

  return (
    <ThemeContext.Provider value={{ theme: theme ?? "system", setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useAppTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useAppTheme must be used inside ThemeProvider");
  }
  return value;
}
