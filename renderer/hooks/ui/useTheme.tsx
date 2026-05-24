import { createContext, use, useEffect, useState, type ReactNode } from "react";
import type { Theme } from "@shared/schemas";
import { useGlobalConfig } from "../config/useGlobalConfig";

interface ThemeState {
  // Persisted value from config.json — what the settings UI considers "saved".
  saved: Theme;
  // Live value driving <html class="dark"> and the BrowserWindow background.
  // Equals `override ?? saved`.
  applied: Theme;
  resolved: "light" | "dark";
  // Settings calls this to stage a preview; passing null clears the
  // override and snaps back to whatever is currently saved.
  setOverride: (theme: Theme | null) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);
export const THEME_STORAGE_KEY = "shigomori.theme";

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readBootHint(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { data: config, isLoading } = useGlobalConfig();
  // Avoid a one-frame light-mode flash while globalConfig fetches by trusting
  // the last value we cached locally. Config wins as soon as it arrives.
  const [bootHint] = useState<Theme>(() => readBootHint());
  const saved: Theme = isLoading ? bootHint : (config?.theme ?? "system");
  const [override, setOverride] = useState<Theme | null>(null);
  const applied = override ?? saved;

  // Once a save lands and `saved` catches up to the staged override, drop the
  // override so future updates to `saved` (e.g. nuke) flow through.
  useEffect(() => {
    if (override && saved === override) setOverride(null);
  }, [override, saved]);

  const [systemTheme, setSystemTheme] = useState<"light" | "dark">(() =>
    getSystemTheme(),
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? "dark" : "light");
    };
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const resolved = applied === "system" ? systemTheme : applied;

  useEffect(() => {
    const root = document.documentElement;
    if (resolved === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [resolved]);

  // Keep the main process in sync so the BrowserWindow background tracks
  // the applied theme (including unsaved previews).
  useEffect(() => {
    void window.api.runtime.setTheme(applied);
  }, [applied]);

  // Mirror the saved value into localStorage so the next launch can paint
  // without waiting for globalConfig to load.
  useEffect(() => {
    if (isLoading) return;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, saved);
    } catch {
      // localStorage may be unavailable; not fatal.
    }
  }, [isLoading, saved]);

  return (
    <ThemeContext value={{ saved, applied, resolved, setOverride }}>
      {children}
    </ThemeContext>
  );
}

export function useTheme(): ThemeState {
  const ctx = use(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used inside ThemeProvider");
  }
  return ctx;
}
