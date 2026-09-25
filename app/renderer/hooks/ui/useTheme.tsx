import { createContext, use, useEffect, useState, type ReactNode } from "react";
import type { Theme } from "@shared/schemas";
import { readStored, writeStored } from "@/lib/localStorage";
import { useClientConfig } from "../config/useClientConfig";

interface ThemeState {
  // Persisted value from clientConfig.json: what the settings UI
  // considers "saved".
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
const THEME_STORAGE_KEY = "shigomori.theme";

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readBootHint(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = readStored(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { data: config, isLoading } = useClientConfig();
  // Avoid a one-frame light-mode flash while clientConfig fetches by
  // trusting the localStorage mirror. Read live at evaluation time, not
  // captured at mount: a later cache clear (nuke) must fall back to the
  // current mirror, not flash the launch-time value. Config wins as
  // soon as it arrives.
  const saved: Theme = isLoading ? readBootHint() : (config?.theme ?? "system");
  const [override, setOverride] = useState<Theme | null>(null);
  const applied = override ?? saved;

  // Once a save lands and `saved` catches up to the staged override, drop the
  // override so future updates to `saved` flow through. Adjusted
  // during render (not in an effect) so no committed frame holds the stale
  // pair; `applied` is identical either way, so nothing visibly changes.
  if (override && saved === override) setOverride(null);

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
  // the applied theme (including unsaved previews). Non-persisting: the
  // saved value lands through the clientConfig write instead.
  useEffect(() => {
    void window.api.window.previewTheme(applied);
  }, [applied]);

  // Mirror the saved value into localStorage so the next launch can paint
  // without waiting for clientConfig to load.
  useEffect(() => {
    if (isLoading) return;
    writeStored(THEME_STORAGE_KEY, saved);
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
