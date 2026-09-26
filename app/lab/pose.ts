// URL posing for one-shot headless screenshots, shared by both lab
// entries (lab/main.tsx and lab/web-main.tsx pose identically):
//   ?theme=light|dark        (default light)
//   ?doubutsu=0|1            (default 1, matching the product default)
// The other params are read where they are answered: ?peers by the
// fixture bridge, ?to by the desktop entry's memory router.
//
// Theme must be seeded BEFORE index.css/providers evaluate, mirroring
// what boot-theme.js does for the persisted keys, so each entry calls
// this before installing its bridge and importing the app.
// ?today=MM-DD (or YYYY-MM-DD): the calendar day the lab poses, for a
// villager's birthday, or null to keep the clock's. Read by the app
// (lab/boot.tsx poses useToday) and the fixture name pick alike.
export function posedToday(): Date | null {
  const raw = new URLSearchParams(location.search).get("today");
  const match = raw?.match(/^(?:(\d{4})-)?(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = match[1] ? Number(match[1]) : new Date().getFullYear();
  return new Date(year, Number(match[2]) - 1, Number(match[3]), 12);
}

export function applyPose(): void {
  const pose = new URLSearchParams(location.search);
  const theme = pose.get("theme") === "dark" ? "dark" : "light";
  const doubutsu = pose.get("doubutsu") !== "0";
  localStorage.setItem("shigomori.theme", theme);
  localStorage.setItem("shigomori.doubutsu", String(doubutsu));
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
    JSON.stringify({ ...stored, theme, doubutsu }),
  );
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  document.documentElement.classList.toggle("doubutsu", doubutsu);
}
