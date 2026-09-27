// The code surface every pierre view shares: the diffs, and the files
// page's viewer.
export const CODE_THEME = {
  theme: { dark: "pierre-dark", light: "pierre-light" } as const,
  // Pin the code's base bg to the app's `--background` token. All the
  // per-row backgrounds (buffer, context, separator) derive from
  // `--diffs-bg` via color-mix, so overriding the one variable
  // cascades through the whole surface. Without this the code reads as
  // a pitch-black slab against the lifted neutral-900 main pane that
  // PR #59 introduced. `unsafeCSS` is the documented path for CSS
  // overrides. See https://diffs.com/docs (Hunk Separators).
  unsafeCSS: `:host { --diffs-bg: var(--background); }`,
};

// In pixels, and numbers rather than CSS because the diff pane's
// virtualizer places undrawn rows by them too (DiffView's DIFF_METRICS).
export const CODE_LINE_HEIGHT = 18;
export const CODE_GAP_BLOCK = 4;

// CSS custom properties inherit through the library's shadow DOM, so
// setting them on a wrapper applies to every pierre child.
export const CODE_STYLE = {
  "--diffs-font-size": "12px",
  "--diffs-line-height": `${CODE_LINE_HEIGHT}px`,
  "--diffs-gap-block": `${CODE_GAP_BLOCK}px`,
  "--diffs-gap-inline": "6px",
} as React.CSSProperties;
