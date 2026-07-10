import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { useGlobalConfig } from "../config/useGlobalConfig";

interface DoubutsuState {
  // Persisted value from config.json: what Settings considers "saved".
  saved: boolean;
  // Live value driving the `.doubutsu` class on <html>. Equals
  // `override ?? saved`.
  applied: boolean;
  // Settings calls this to stage a preview; passing null clears the
  // override and snaps back to whatever is currently saved.
  setOverride: (next: boolean | null) => void;
}

const DoubutsuContext = createContext<DoubutsuState | null>(null);
export const DOUBUTSU_STORAGE_KEY = "shigomori.doubutsu";

function readBootHint(): boolean {
  // Default is ON: only an explicit "false" (a saved opt-out) disables
  // the first paint's doubutsu look.
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(DOUBUTSU_STORAGE_KEY) !== "false";
}

export function DoubutsuProvider({ children }: { children: ReactNode }) {
  const { data: config, isLoading } = useGlobalConfig();
  // Avoid a one-frame v1-look flash while globalConfig fetches by trusting
  // the last cached value. Config wins as soon as it arrives.
  const [bootHint] = useState<boolean>(() => readBootHint());
  const saved: boolean = isLoading ? bootHint : (config?.doubutsu ?? true);
  const [override, setOverride] = useState<boolean | null>(null);
  const applied = override ?? saved;

  // Once a save lands and `saved` catches up to the staged override,
  // drop the override so future updates to `saved` (e.g. nuke) flow.
  useEffect(() => {
    if (override !== null && saved === override) setOverride(null);
  }, [override, saved]);

  useEffect(() => {
    const root = document.documentElement;
    if (applied) {
      root.classList.add("doubutsu");
    } else {
      root.classList.remove("doubutsu");
    }
  }, [applied]);

  // Keep the main process in sync so native chrome (the Windows caption
  // overlay and window background) tracks the applied value, including
  // unsaved previews -- mirrors useTheme's setTheme effect.
  useEffect(() => {
    void window.api.runtime.setDoubutsu(applied);
  }, [applied]);

  // Mirror the saved value into localStorage so the next launch can
  // paint without waiting for globalConfig to load.
  useEffect(() => {
    if (isLoading) return;
    try {
      window.localStorage.setItem(
        DOUBUTSU_STORAGE_KEY,
        saved ? "true" : "false",
      );
    } catch {
      // localStorage may be unavailable; not fatal.
    }
  }, [isLoading, saved]);

  return (
    <DoubutsuContext value={{ saved, applied, setOverride }}>
      {children}
    </DoubutsuContext>
  );
}

export function useDoubutsu(): DoubutsuState {
  const ctx = use(DoubutsuContext);
  if (!ctx) {
    throw new Error("useDoubutsu must be used inside DoubutsuProvider");
  }
  return ctx;
}
