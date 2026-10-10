// Light or dark. Loaded blocking in <head> so the theme is set before
// first paint. The page follows the system until the visitor picks the
// other theme with the toggle, which is remembered. Toggling back to the
// system's theme forgets the choice, so the page follows the system
// again.
const KEY = "theme";
const root = document.documentElement;
const system = matchMedia("(prefers-color-scheme: dark)");
// The nav's mint in each theme, for the browser bar on phones.
const BAR = { light: "#cff2de", dark: "#1c2b23" };
// The app's frames that wear the page's theme (Frame.astro) carry it on
// their root as the app's window does: the dark class, and the app's
// default palette for each appearance (@shigomori/ui's themes.ts).
const FRAMES = "[data-page-theme]";
const PALETTE = { light: "cream", dark: "charcoal" };

function dress(frame, theme) {
  frame.classList.toggle("dark", theme === "dark");
  frame.dataset.palette = PALETTE[theme];
  frame.style.colorScheme = theme;
}

function apply(theme) {
  root.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", BAR[theme]);
  for (const frame of document.querySelectorAll(FRAMES)) dress(frame, theme);
}

function stored() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

apply(stored() ?? (system.matches ? "dark" : "light"));

// The frames are parsed after this runs: each is dressed as it arrives,
// before it paints. The live app mounts into the same root later on.
const arriving = new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node instanceof Element && node.matches(FRAMES)) {
        dress(node, root.dataset.theme);
      }
    }
  }
});
arriving.observe(root, { childList: true, subtree: true });
document.addEventListener("DOMContentLoaded", () => arriving.disconnect());

system.addEventListener("change", (event) => {
  if (!stored()) apply(event.matches ? "dark" : "light");
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-theme-toggle]")) return;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  apply(next);
  const systemTheme = system.matches ? "dark" : "light";
  try {
    if (next === systemTheme) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {}
});
