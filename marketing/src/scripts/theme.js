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

function apply(theme) {
  root.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", BAR[theme]);
}

function stored() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

apply(stored() ?? (system.matches ? "dark" : "light"));

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
