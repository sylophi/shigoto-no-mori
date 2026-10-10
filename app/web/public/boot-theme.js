// Applies the persisted appearance to the theme root (#root, which the
// page loads this right after) synchronously, before React runs, so
// the first paint matches the user's choice. Loaded as an external
// classic script (a render-blocking script keeps the pre-paint
// guarantee) rather than inline, so the deploy's
// Content-Security-Policy can stay at script-src 'self' with no inline
// allowance. Keys must match THEME_STORAGE_KEY in
// renderer/hooks/ui/useTheme.tsx and STORAGE_KEYS in
// renderer/hooks/ui/usePalette.tsx, and the palette defaults
// packages/ui/src/lib/themes.ts.
(function () {
  var root = document.getElementById("root");
  try {
    var stored = localStorage.getItem("shigomori.theme") || "system";
    var dark =
      stored === "dark" ||
      (stored === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) root.classList.add("dark");
    root.style.colorScheme = dark ? "dark" : "light";
    // Doubutsu is on by default; only a saved opt-out disables the
    // first paint's overlay, mirroring readBootHint. Its palette is
    // the saved pick for the appearance being painted, else the
    // list's default.
    if (localStorage.getItem("shigomori.doubutsu") !== "false") {
      root.classList.add("doubutsu");
      root.dataset.palette =
        localStorage.getItem(
          dark ? "shigomori.darkTheme" : "shigomori.lightTheme",
        ) || (dark ? "charcoal" : "cream");
    }
  } catch {
    // localStorage may be unavailable in some contexts; render light.
  }
  // The page's canvas wears the root's background (the stylesheets
  // theme the root, not the page), or on a phone its card, where the
  // rubber band is off: what a rubber band shows, and what Safari tints
  // its toolbars from. AppShell keeps both in step. The breakpoint must match
  // renderer/hooks/ui/useViewport.ts.
  if (root.dataset.shell === "web") {
    var style = getComputedStyle(root);
    var phone = root.getBoundingClientRect().width < 768;
    var canvas = phone
      ? style.getPropertyValue("--card")
      : style.backgroundColor;
    document.documentElement.style.backgroundColor = canvas;
    document.body.style.backgroundColor = canvas;
    if (phone) document.documentElement.style.overscrollBehaviorY = "none";
  }
})();
