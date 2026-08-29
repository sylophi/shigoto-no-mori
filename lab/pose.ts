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
export function applyPose(): void {
  const pose = new URLSearchParams(location.search);
  const theme = pose.get("theme") === "dark" ? "dark" : "light";
  const doubutsu = pose.get("doubutsu") !== "0";
  localStorage.setItem("shigomori.theme", theme);
  localStorage.setItem("shigomori.doubutsu", String(doubutsu));
  localStorage.setItem(
    "sm.lab.clientConfig",
    JSON.stringify({ theme, doubutsu }),
  );
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  document.documentElement.classList.toggle("doubutsu", doubutsu);
}
