// Applies the persisted appearance synchronously before any CSS or
// React runs, so the first paint matches the user's choice. Loaded as
// an external classic script (a render-blocking head script keeps the
// pre-paint guarantee) rather than inline, so the deploy's
// Content-Security-Policy can stay at script-src 'self' with no inline
// allowance. Keys must match THEME_STORAGE_KEY in
// renderer/hooks/ui/useTheme.tsx and DOUBUTSU_STORAGE_KEY in
// renderer/hooks/ui/useDoubutsu.tsx.
(function () {
  try {
    var stored = localStorage.getItem("shigomori.theme") || "system";
    var dark =
      stored === "dark" ||
      (stored === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    var html = document.documentElement;
    if (dark) html.classList.add("dark");
    html.style.colorScheme = dark ? "dark" : "light";
    // Doubutsu is on by default; only a saved opt-out disables the
    // first paint's overlay, mirroring readBootHint.
    if (localStorage.getItem("shigomori.doubutsu") !== "false") {
      html.classList.add("doubutsu");
    }
  } catch {
    // localStorage may be unavailable in some contexts; render light.
  }
})();
