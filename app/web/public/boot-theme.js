// Applies the persisted appearance synchronously before any CSS or
// React runs, so the first paint matches the user's choice. Loaded as
// an external classic script (a render-blocking head script keeps the
// pre-paint guarantee) rather than inline, so the deploy's
// Content-Security-Policy can stay at script-src 'self' with no inline
// allowance. Keys must match THEME_STORAGE_KEY in
// renderer/hooks/ui/useTheme.tsx and STORAGE_KEYS in
// renderer/hooks/ui/usePalette.tsx, and the palette defaults
// shared/themes.ts.
(function () {
  var html = document.documentElement;
  // The phone layout's marker, pre-paint for the same reason as the
  // theme classes; AppShell keeps it in step with resizes afterwards.
  // Outside the try: it reads no storage, so a storage-blocked context
  // must not lose it. The breakpoint must match
  // renderer/hooks/ui/useViewport.ts (and lab/demo/main.tsx, which
  // stamps it the same way).
  if (!window.matchMedia("(min-width: 48rem)").matches) {
    html.dataset.layout = "phone";
  }
  try {
    var stored = localStorage.getItem("shigomori.theme") || "system";
    var dark =
      stored === "dark" ||
      (stored === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) html.classList.add("dark");
    html.style.colorScheme = dark ? "dark" : "light";
    // Doubutsu is on by default; only a saved opt-out disables the
    // first paint's overlay, mirroring readBootHint. Its palette is
    // the saved pick for the appearance being painted, else the
    // list's default.
    if (localStorage.getItem("shigomori.doubutsu") !== "false") {
      html.classList.add("doubutsu");
      html.dataset.palette =
        localStorage.getItem(
          dark ? "shigomori.darkTheme" : "shigomori.lightTheme",
        ) || (dark ? "charcoal" : "cream");
    }
  } catch {
    // localStorage may be unavailable in some contexts; render light.
  }
})();
