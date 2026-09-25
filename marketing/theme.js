// Light or dark. Loaded blocking in <head> so the theme is set before
// first paint. The page follows the system until the visitor picks the
// other theme with the toggle, which is remembered. Toggling back to the
// system's theme forgets the choice, so the page follows the system
// again.
const KEY = "theme";
const root = document.documentElement;
const system = matchMedia("(prefers-color-scheme: dark)");

function stored() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

root.dataset.theme = stored() ?? (system.matches ? "dark" : "light");

system.addEventListener("change", (event) => {
  if (!stored()) root.dataset.theme = event.matches ? "dark" : "light";
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-theme-toggle]")) return;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  const systemTheme = system.matches ? "dark" : "light";
  try {
    if (next === systemTheme) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {}
});
