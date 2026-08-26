import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { useClientConfig } from "../config/useClientConfig";
import { readStored, writeStored } from "@/lib/localStorage";

interface DoubutsuState {
  // Persisted value from clientConfig.json: what Settings considers
  // "saved".
  saved: boolean;
  // Live value driving the `.doubutsu` class on <html>. Equals
  // `override ?? saved`.
  applied: boolean;
  // Settings calls this to stage a preview; passing null clears the
  // override and snaps back to whatever is currently saved.
  setOverride: (next: boolean | null) => void;
}

const DoubutsuContext = createContext<DoubutsuState | null>(null);
const DOUBUTSU_STORAGE_KEY = "shigomori.doubutsu";

function readBootHint(): boolean {
  // Default is ON: only an explicit "false" (a saved opt-out) disables
  // the first paint's doubutsu look.
  if (typeof window === "undefined") return true;
  return readStored(DOUBUTSU_STORAGE_KEY) !== "false";
}

export function DoubutsuProvider({ children }: { children: ReactNode }) {
  const { data: config, isLoading } = useClientConfig();
  // Avoid a one-frame v1-look flash while clientConfig fetches by
  // trusting the localStorage mirror. Read live at evaluation time, not
  // captured at mount: a later cache clear (nuke) must fall back to the
  // current mirror, not flash the launch-time value. Config wins as
  // soon as it arrives.
  const saved: boolean = isLoading
    ? readBootHint()
    : (config?.doubutsu ?? true);
  const [override, setOverride] = useState<boolean | null>(null);
  const applied = override ?? saved;

  // Once a save lands and `saved` catches up to the staged override,
  // drop the override so future updates to `saved` flow.
  // Adjusted during render (not in an effect) so no committed frame holds
  // the stale pair; `applied` is identical either way.
  if (override !== null && saved === override) setOverride(null);

  useEffect(() => {
    const root = document.documentElement;
    if (applied) {
      root.classList.add("doubutsu");
    } else {
      root.classList.remove("doubutsu");
    }
  }, [applied]);

  // Mirror the saved value into localStorage so the next launch can
  // paint without waiting for clientConfig to load.
  useEffect(() => {
    if (isLoading) return;
    writeStored(DOUBUTSU_STORAGE_KEY, saved ? "true" : "false");
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
