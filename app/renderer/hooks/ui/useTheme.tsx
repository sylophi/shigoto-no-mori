import {
  createContext,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Theme } from "@shigomori/contracts/schemas";
import { readStored, writeStored } from "@/lib/localStorage";
import { useClientConfig } from "../config/useClientConfig";
import { useWindowRoot } from "@/lib/themeRoot";

interface ThemeState {
  // Persisted value from clientConfig.json: what the settings UI
  // considers "saved".
  saved: Theme;
  // Live value driving the root's `dark` class and the BrowserWindow
  // background.
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
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function readBootHint(): Theme {
  const stored = readStored(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

// Whether the root wears `dark`, kept in step as whoever owns it
// switches it.
function useRootIsDark(root: HTMLElement): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(root, { attributeFilter: ["class"] });
      return () => observer.disconnect();
    },
    () => root.classList.contains("dark"),
  );
}

export function ThemeProvider({
  fromRoot,
  children,
}: {
  // The window's appearance is its root's, set by the page around it
  // (a frame on the marketing site), rather than the settings'. The
  // settings still read and save as usual; they just don't reach the
  // root.
  fromRoot: boolean;
  children: ReactNode;
}) {
  const root = useWindowRoot();
  const rootIsDark = useRootIsDark(root);
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

  const settingsResolved = applied === "system" ? systemTheme : applied;
  const resolved = fromRoot
    ? rootIsDark
      ? "dark"
      : "light"
    : settingsResolved;

  useEffect(() => {
    if (!fromRoot) root.classList.toggle("dark", resolved === "dark");
  }, [fromRoot, root, resolved]);

  // Keep the main process in sync so the BrowserWindow background tracks
  // the applied theme (including unsaved previews). Non-persisting: the
  // saved value lands through the clientConfig write instead.
  useEffect(() => {
    if (!fromRoot) void window.api.window.previewTheme({ theme: applied });
  }, [fromRoot, applied]);

  // Mirror the saved value into localStorage so the next launch can paint
  // without waiting for clientConfig to load.
  useEffect(() => {
    if (isLoading || fromRoot) return;
    writeStored(THEME_STORAGE_KEY, saved);
  }, [isLoading, fromRoot, saved]);

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
