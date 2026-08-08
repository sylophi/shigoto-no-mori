# Shigoto no Mori

## Theming: two visual systems, one component tree

The app ships two designs: **doubutsu** (default: Animal Crossing
overlay, class `doubutsu` on `<html>`, orthogonal to light/dark) and
**v1** (neutral shadcn-style, the opt-out via Settings → Appearance).
There is ONE component tree — doubutsu is `renderer/doubutsu.css`
remapping tokens and hooking stable attributes on top of the v1 base.
Keep it that way; never fork a component per theme. Components are
still written in v1's vocabulary (tokens, borders, shadows) — the
overlay handles translation, so build in v1 terms and verify in both.

Rules that keep both themes cheap to maintain:

- **Colors come from theme tokens** (`bg-card`, `text-muted-foreground`,
  `--input`, …), never hardcoded values. For status/semantic color, use
  only the four raw families already in use — `emerald` (success/add),
  `rose` (danger/delete), `amber` (warning), `sky` (info/update) —
  doubutsu remaps exactly these via `--color-*`. A new raw family needs
  a matching remap entry in doubutsu.css.
- **Interactive primitives carry `data-slot`** (and `data-variant` where
  variants matter). Text fields use `ui/input.tsx` / `ui/textarea.tsx`,
  chips use `ui/chip-button.tsx`, few-way toggles use
  `ui/segmented-control.tsx` — don't re-inline their class strings.
- **doubutsu.css may only select**: theme tokens, `data-slot` /
  `data-doubutsu-zone` attributes, upstream library attributes (Base UI
  `data-highlighted` etc.), and plain Tailwind utility names. Never a
  component's internal utility-class combination — that breaks silently
  when the component is restyled.
- The full dependency list lives in the CONTRACT header of
  `renderer/doubutsu.css`; `pnpm theme:check` (run by lefthook
  pre-commit) verifies every hook still exists. If it fails, either
  restore the hook or update the CSS + CONTRACT together.
- When changing UI chrome (surfaces, borders, focus, hover), eyeball
  all four modes. In dev builds: Ctrl+T toggles light/dark, Ctrl+D
  toggles doubutsu, Ctrl+R resets to saved — non-persisted previews
  (components/DevThemeHotkeys.tsx), inactive while a text field has
  focus. Settings → Appearance does the same with a save option.
