# Shigoto no Mori: design notes

Rules for the app's visual layer. They apply to every component in
`renderer/`, which the desktop window and the web client (`web/`) both
render.

## Theming: two visual systems, one component tree

The app ships two designs: **doubutsu** (default: Animal Crossing
overlay, class `doubutsu` on `<html>`, orthogonal to light/dark) and
**v1** (neutral shadcn-style, the opt-out via Settings → Appearance).
There is ONE component tree: doubutsu is `renderer/doubutsu.css`
remapping tokens and hooking stable attributes on top of the v1 base.
Keep it that way; never fork a component per theme. Components are
still written in v1's vocabulary (tokens, borders, shadows), and the
overlay handles translation, so build in v1 terms and verify in both.

Rules that keep both themes cheap to maintain:

- **Colors come from theme tokens** (`bg-card`, `text-muted-foreground`,
  `--input`, …), never hardcoded values. For status/semantic color, use
  only the four raw families already in use: `emerald` (success/add),
  `rose` (danger/delete), `amber` (warning), `sky` (info/update). Those
  four are exactly what doubutsu remaps via `--color-*`. A new raw
  family needs a matching remap entry in doubutsu.css.
- **Interactive primitives carry `data-slot`** (and `data-variant` where
  variants matter). Text fields use `ui/input.tsx` / `ui/textarea.tsx`,
  chips use `ui/chip-button.tsx`, few-way toggles use
  `ui/segmented-control.tsx`. Don't re-inline their class strings.
- **doubutsu.css may only select**: theme tokens, `data-slot` /
  `data-doubutsu-zone` / `data-doubutsu-page` attributes, upstream
  library attributes (Base UI `data-highlighted` etc.), and plain
  Tailwind utility names. Never a component's internal utility-class
  combination. That breaks silently when the component is restyled.
- The full dependency list lives in the CONTRACT header of
  `renderer/doubutsu.css`; `pnpm test theme-contract` (run by lefthook
  pre-commit) verifies every hook still exists. If it fails, either
  restore the hook or update the CSS + CONTRACT together.
- When changing UI chrome (surfaces, borders, focus, hover), eyeball
  all four modes. In dev builds: Ctrl+T toggles light/dark, Ctrl+D
  toggles doubutsu, Ctrl+R resets to saved. These are non-persisted
  previews (components/DevThemeHotkeys.tsx), inactive while a text
  field has focus, except the script console's terminal, where they
  still win (there Ctrl+D would be EOF and end the running program).
  Settings → Appearance does the same with a save option.

## Sizing: one density in the components, the phone's in phone.css

Components are written once, at desktop density. The web client's
phone layout (`<html data-layout="phone">`) does not get a size per
call site: `renderer/phone.css` remaps the type and spacing scales
there, gives the primitives their touch minimums, and extends every
other interactive element's hit area to 44px. Its header explains the
three layers.

Rules that keep that working:

- **Sizes come from the scale.** `text-xs`, `text-2xs`, `h-7`, `p-1`,
  `size-4`, never `text-[11px]` or `h-[28px]`: a literal stays the same
  size on a phone. The steps under `text-xs` are `text-2xs` (11px),
  `text-3xs` (10px) and `text-4xs` (9px). Display art (the wallpaper
  glyphs) is the exception.
- **Tappable things are real controls**: a `<button>`, an `<a href>`,
  or an element with the matching `role`. The hit-area rule finds them
  by tag and role, so a `<div onClick>` gets no touch target. On a
  phone that rule owns their `::after`, so don't style one.
- **Small controls that pack tight get a real size, not a hit area.**
  An expanded hit area reaches over its neighbours. Rows that stack
  edge to edge and pills in a scrolling strip are sized in phone.css's
  second layer (by role, or a `data-slot` on the row). A link in
  running text opts out with `data-no-hit-area`.
- **`phone:` is for layout, not size.** Hiding a column, restacking a
  row, showing a hover-only action, and the page gutters, which narrow
  on a phone while everything else grows (`PAGE_BODY` in
  `shared/PageShell.tsx` and `PAGE_HEADER_PADDING` carry them, so a
  page reuses those). A `phone:` utility that only makes a control or
  its text bigger belongs in phone.css as a scale or control change.
- The `data-*` hooks phone.css selects are verified by
  `pnpm test theme-contract`, like doubutsu's.
- When changing UI, check it at phone width as well. The UI lab's web
  flavor (`lab/README.md`) renders the phone layout at any viewport
  under 768px with no sign-in.
