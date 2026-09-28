// URL posing for one-shot headless screenshots, shared by both lab
// entries (lab/main.tsx and lab/web-main.tsx pose identically):
//   ?theme=light|dark        (default light)
//   ?doubutsu=0|1            (default 1, matching the product default)
//   ?light=<id>, ?dark=<id>  the doubutsu palette of each appearance
//                            (the ids in shared/themes.ts, default
//                            cream and charcoal)
//   ?updatedFrom=<version>   the build the window last ran (below)
// The other params are read where they are answered: ?peers by the
// fixture bridge, ?to by the desktop entry's memory router.
//
// Theme must be seeded BEFORE index.css/providers evaluate, mirroring
// what boot-theme.js does for the persisted keys, so each entry calls
// this before installing its bridge and importing the app.
import {
  DARK_THEME_IDS,
  type DarkTheme,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  LIGHT_THEME_IDS,
  type LightTheme,
} from "../shared/themes";

function pickOf<Id extends string>(
  raw: string | null,
  ids: readonly Id[],
  fallback: Id,
): Id {
  return ids.includes(raw as Id) ? (raw as Id) : fallback;
}

export function applyPose(): void {
  const pose = new URLSearchParams(location.search);
  const theme = pose.get("theme") === "dark" ? "dark" : "light";
  const doubutsu = pose.get("doubutsu") !== "0";
  const light: LightTheme = pickOf(
    pose.get("light"),
    LIGHT_THEME_IDS,
    DEFAULT_LIGHT_THEME,
  );
  const dark: DarkTheme = pickOf(
    pose.get("dark"),
    DARK_THEME_IDS,
    DEFAULT_DARK_THEME,
  );
  localStorage.setItem("shigomori.theme", theme);
  localStorage.setItem("shigomori.doubutsu", String(doubutsu));
  localStorage.setItem("shigomori.lightTheme", light);
  localStorage.setItem("shigomori.darkTheme", dark);
  // Posed over whatever the lab session saved, so a reload keeps the
  // rest of the client config (folds, the sidebar view, quick-create
  // picks) the way the real store would.
  // Parsed here rather than through a renderer helper: this runs
  // before the bridge owns window.api, when no renderer module may load.
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(localStorage.getItem("sm.lab.clientConfig") ?? "{}");
  } catch {
    // Corrupt storage reads as defaults.
  }
  localStorage.setItem(
    "sm.lab.clientConfig",
    JSON.stringify({
      ...stored,
      theme,
      doubutsu,
      lightTheme: light,
      darkTheme: dark,
    }),
  );
  // ?updatedFrom=<version>: the build this window last ran, as if the
  // lab's own (LAB_APP_VERSION) had just updated from it, for the
  // update toast (components/UpdateNews.tsx). Absent, the record is
  // left alone, so the lab's own runs stay quiet.
  const updatedFrom = pose.get("updatedFrom");
  if (updatedFrom !== null) {
    localStorage.setItem("shigomori.lastVersion", updatedFrom);
  }
  const html = document.documentElement;
  html.classList.toggle("dark", theme === "dark");
  html.style.colorScheme = theme;
  html.classList.toggle("doubutsu", doubutsu);
  if (doubutsu) html.dataset.palette = theme === "dark" ? dark : light;
  else delete html.dataset.palette;
}
