# Shigoto no Mori

## Theming: two visual systems, one component tree

The app ships two designs: **v1** (default, neutral shadcn-style) and
**doubutsu** (opt-in Animal Crossing overlay, toggled in Settings, class
`doubutsu` on `<html>`, orthogonal to light/dark). There is ONE component
tree — doubutsu is `renderer/doubutsu.css` remapping tokens and hooking
stable attributes. Keep it that way; never fork a component per theme.

Rules that keep both themes cheap to maintain:

- **Colors come from theme tokens** (`bg-card`, `text-muted-foreground`,
  `--input`, …), never hardcoded values. For status/semantic color, use
  only the four raw families already in use — `emerald` (success/add),
  `rose` (danger/delete), `amber` (warning), `sky` (info/update) —
  doubutsu remaps exactly these via `--color-*`. A new raw family needs
  a matching remap entry in doubutsu.css.
- **Interactive primitives carry `data-slot`** (and `data-variant` where
  variants matter). Text fields use `ui/input.tsx` / `ui/textarea.tsx`,
  chips use `ui/chip-button.tsx` — don't re-inline their class strings.
- **doubutsu.css may only select**: theme tokens, `data-slot` /
  `data-doubutsu-zone` attributes, upstream library attributes (Base UI
  `data-highlighted` etc.), and plain Tailwind utility names. Never a
  component's internal utility-class combination — that breaks silently
  when the component is restyled.
- The full dependency list lives in the CONTRACT header of
  `renderer/doubutsu.css`; `pnpm check:theme` (run by lefthook
  pre-commit) verifies every hook still exists. If it fails, either
  restore the hook or update the CSS + CONTRACT together.
- When changing UI chrome (surfaces, borders, focus, hover), eyeball
  both themes: Settings → Appearance → Doubutsu mode toggles it live
  without saving.
