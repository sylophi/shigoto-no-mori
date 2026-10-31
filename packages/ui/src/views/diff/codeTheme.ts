// The code surface every pierre view shares: the diffs, and the files
// page's viewer.
export const CODE_THEME = {
  theme: { dark: "pierre-dark", light: "pierre-light" } as const,
  // Pin the code's base bg to the app's `--background` token. All the
  // per-row backgrounds (buffer, context, separator) derive from
  // `--diffs-bg` via color-mix, so overriding the one variable
  // cascades through the whole surface. Without this the code reads as
  // a pitch-black slab against the lifted main pane (index.css).
  // `unsafeCSS` is the documented path for CSS overrides. See
  // https://diffs.com/docs (Hunk Separators).
  // The code blocks take the app's native scrollbar (index.css), so
  // they scroll only when they overflow and reserve no gutter: where
  // the platform draws classic bars, the library's always-on scroll and
  // stable gutter would give every block an empty bar.
  // The find's highlights (index.css) are painted in the shadow root
  // by rules of its own: the page's rules don't reach in.
  unsafeCSS: `:host { --diffs-bg: var(--background); --diffs-overflow-override: auto; } [data-code] { scrollbar-gutter: auto; } ::highlight(find) { background-color: var(--find-match); } ::highlight(find-current) { background-color: var(--find-current); }`,
};

// In pixels, and numbers rather than CSS because the diff pane's
// virtualizer places undrawn rows by them too (DiffPageView's DIFF_METRICS).
export const CODE_LINE_HEIGHT = 18;
export const CODE_GAP_BLOCK = 4;

// CSS custom properties and inherited properties reach through the
// library's shadow DOM, so setting them on a wrapper applies to every
// pierre child. Ligatures stay off, as everywhere code shows (index.css).
export const CODE_STYLE = {
  "--diffs-font-family": "var(--font-mono)",
  fontVariantLigatures: "none",
  "--diffs-font-size": "12px",
  "--diffs-line-height": `${CODE_LINE_HEIGHT}px`,
  "--diffs-gap-block": `${CODE_GAP_BLOCK}px`,
  "--diffs-gap-inline": "6px",
} as React.CSSProperties;
