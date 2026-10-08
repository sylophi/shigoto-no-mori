# Shigoto no Mori: design notes

Rules for the app's visual layer. They apply to every component in
`renderer/`, which the desktop window and the web client (`web/`) both
render.

## Theming: two visual systems, one component tree

The app ships two designs: **doubutsu** (default: Animal Crossing
overlay, class `doubutsu` on `<html>`, orthogonal to light/dark) and
**v1** (neutral shadcn-style, the opt-out via Settings → Appearance).
There is ONE component tree: doubutsu is
`renderer/doubutsu.css` remapping tokens and hooking stable attributes
on top of the v1 base. Keep it that way; never fork a component per
theme. Components are still written in v1's vocabulary (tokens,
borders, shadows), and the overlay handles translation, so build in v1
terms and verify in both.

Doubutsu comes in palettes, picked per appearance under its switch (a
light one and a dark one, `lightTheme` / `darkTheme` beside `doubutsu`
in client config, the catalog in `shared/themes.ts`). The pick lands
as `data-palette` on `<html>`:
`renderer/doubutsu.css` carries the defaults (cream, charcoal) and
`renderer/palettes.css` the rest, each remapping the surface tokens
and its accent: `--primary` and `--ring` (switches, the loud button)
and the emerald steps, so the online dots, the device tiles and every
other positive status wear the palette's hue. A rule in doubutsu.css
reaches every color through a token, never a literal, so a palette can
move it. Settings paints its swatches with the same blocks
(`[data-theme-scope]` beside `:root`), so a new palette is one CSS
block plus a catalog entry. Palettes that differ in a detail (latte's
greens) can wait as variants: ids of their own behind one swatch,
left out of the picker and reached only by Ctrl+Alt+Shift+L
(shared/themes.ts).

Rules that keep both themes cheap to maintain:

- **Colors come from theme tokens** (`bg-card`, `text-muted-foreground`,
  `--input`, …), never hardcoded values. For status/semantic color, use
  only the raw families already in use: `emerald` (success, which
  follows the palette's accent), `rose` (danger/delete), `amber`
  (warning), `sky` (info/update), and `green` for what is literally
  green (a diff's additions, Nook's leaf), which no palette moves.
  Those are what
  doubutsu remaps via `--color-*`. A new raw family needs a matching
  remap entry in doubutsu.css.
- **Interactive primitives carry `data-slot`** (and `data-variant` where
  variants matter). Text fields use `ui/input.tsx` / `ui/textarea.tsx`,
  chips use `ui/chip-button.tsx`, few-way toggles use
  `ui/segmented-control.tsx`. Don't re-inline their class strings.
- **Hover hints are the app's tooltip**, `SimpleTooltip` from
  `ui/tooltip.tsx`, never a `title` attribute: the browser's tooltip
  wears neither theme. `shigomori/no-native-tooltip` (oxlint) catches
  `title` on DOM elements, and the `ui/` wrappers leave `title` out of
  their props. The tooltip is visual only, so an icon-only control
  still needs its `aria-label`.
- **A tooltip is for text that's cut off or a control that's unclear**,
  nothing else: hints that pop up over what already reads fine get in
  the way. Text on screen gets one only while it's cut off
  (`whenTruncated`). Otherwise a hint says what the screen can't: why
  a control is disabled, what a bare mark stands for, a shortcut or a
  hidden gesture, the exact value behind a rounded one (the timestamp
  behind "3d ago"). A bare icon that marks something gets one naming
  it (the primary checkout's house, a device's glyph). A label or a
  familiar icon button (pencil, trash, pin, refresh) needs none, and
  neither does an option in a picker (device pills and tabs, the
  device icon grid): a tip that repeats a control's name or explains a
  plain label is noise.
- **doubutsu.css may only select**: theme tokens, `data-slot` /
  `data-doubutsu-zone` / `data-doubutsu-page` attributes, upstream
  library attributes (Base UI `data-highlighted` etc.), and plain
  Tailwind utility names. Never a component's internal utility-class
  combination. That breaks silently when the component is restyled.
- **No outlines in doubutsu.** No border, hairline or ring draws an
  edge: fills set surfaces apart, and a floating one stands on a hard,
  blur-less drop (`--doubutsu-sticker-shadow`). Keyboard focus rings
  are the one exception. So rows that v1 rules off say what they are
  instead: a search strip carries `data-slot="search-row"` (it becomes
  an inset tray) and a popup's footer `data-slot="footer-row"` (a
  muted band).
- The full dependency list lives in the CONTRACT header of
  `renderer/doubutsu.css`; `pnpm test theme-contract` (run by lefthook
  pre-commit) verifies every hook still exists. If it fails, either
  restore the hook or update the CSS + CONTRACT together.
- When changing UI chrome (surfaces, borders, focus, hover), eyeball
  all four modes, and a palette or two. In dev builds: Ctrl+T toggles
  light/dark, Ctrl+D toggles doubutsu, Ctrl+P cycles its palette,
  Ctrl+R resets to saved. These are non-persisted
  previews (components/DevThemeHotkeys.tsx), inactive while a text
  field has focus, except the script console's terminal, where they
  still win (there Ctrl+D would be EOF and end the running program).
  Settings → Appearance does the same with a save option.

## Sizing: one density in the components, the phone's in phone.css

Components are written once, at desktop density. The web client's
phone layout (`<html data-layout="phone">`) does not get a size per
call site: `renderer/phone.css` remaps the type and spacing scales
there, gives the primitives their touch minimums, extends every
other interactive element's hit area to 44px, and gives hover-only
buttons a resting fill. Its header explains the layers.

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
- **A button shows a fill at rest on a phone.** Nothing hovers there,
  so a hover-only fill never says "tap me". phone.css gives the ghost
  variants a resting fill, and a bare icon button joins them through
  `data-icon-button`: use `ui/icon-button.tsx`, which carries it. A
  page's `<footer>` bar and the back button stay bare, since their
  place on the screen already says control.
- **Raw `:hover` in CSS goes inside `@media (hover: hover)`.** A tap on
  a touch screen leaves `:hover` stuck on the tapped control. Tailwind's
  `hover:` variant is already gated that way (index.css). Hand-written
  theme CSS has to do it itself, and may pair it with `:active` for a
  pressed state (doubutsu's stripes do).
- The `data-*` hooks phone.css selects are verified by
  `pnpm test theme-contract`, like doubutsu's.
- When changing UI, check it at phone width as well. The fake host's
  web flavor (`lab/fake-host/README.md`) renders the phone layout at
  any viewport under 768px with no sign-in.

## Window size: design at the default, hold up around it

The desktop window opens at 920×720 (`main/index.ts`), which leaves a
page about 680px beside the sidebar. Design at that size. The desktop
never switches to the phone layout, so a page also has to hold up
smaller and larger:

- **Down to about 800×550.** Text truncates (with a `whenTruncated`
  tooltip) rather than pushing controls out, rows of controls wrap
  rather than overlap, and nothing scrolls sideways. The window goes
  smaller, but nothing needs designing for below that.
- **Up to a full display.** More room at the same density: running
  text keeps a reading width (`max-w-3xl`).

## Devices: one identity, drawn one way

A device is its name and its icon. The icon is one of the closed
catalog in `shared/account/deviceIcon.ts`: seven device shapes (laptop,
desktop, mini, server, phone, tablet, browser) and a set of marks that
are only ever picked (a leaf, a cat, a rocket), for telling two laptops
apart. The device detects its own shape at
enrollment (`main/core/account/defaultDeviceIcon.ts` on a machine,
`web/account/deviceIcon.ts` in a browser), and its owner can pick
another. The hub keeps both the name and the icon, so either can be
changed on the device's row of any device's account page, online or
not, and every device draws every other one the same way. The device
itself takes its own from the hub on each registry read
(`syncHubDevice` in `shared/account/enroll.ts`).

Rules that keep a machine looking like itself everywhere:

- **Every mark for a device goes through `shared/DeviceGlyph.tsx`.**
  `DeviceGlyph` is the bare glyph, `DeviceLead` the connection dot and
  glyph that leads a name, `DeviceMark` the glyph on a tile in the
  device's connection tone. Never a lucide laptop or monitor picked at
  a call site, and never a mark derived from the name.
- **The icon comes off the device record**, never guessed: a
  `RemoteDevice` and a `DeviceRosterEntry` carry `icon`, this device's
  comes from `useLocalDeviceIcon`, and `useDeviceIcon(deviceId)`
  answers for either.
- **State stays on the dot and the tone.** A device's connection is
  the `StatusDot` beside its glyph (or the tint of its mark), through
  `deviceStatusView`. This device has no connection to show: it wears
  the glyph alone, and where a surface tags it, the tag is
  `THIS_DEVICE_VIEW` (a `RowTag` in a list), never a lowercase aside.
- **A device's tooltip is `deviceTitle`** ("Thinkpad, Connected",
  "Studio Mac, This device") where it has one, as on the chip. The
  device pickers have none (above).

## Village life: rarity

Village life is the cosmetic villager flair: villagers speaking in
toasts about their worktrees, moving in and out as those come and go,
and their face beside the branch title on their worktree's page and
beside the worktree's name in the inbox. It is a setting of each
desktop window (client config, Appearance in Settings), with the
villager data downloaded into that device's data dir
(`host/lib/villagers.ts`), so it covers every device's worktrees
that window shows. A web client offers none: it has no device of its
own to hold the data. Every doubutsu character has a
rarity, like a card's (`shared/villagers/rarity.ts`):

- **Common**: regular villagers.
- **Rare**: special characters that aren't regular villagers (Katrina,
  Pelly, Leif): the villager data marks them special.
- **Legendary**: the household names, picked by hand: Tom Nook,
  Isabelle, K.K. Slider, Timmy, Tommy, Blathers, Celeste, Mr. Resetti,
  Redd, Brewster, Kapp'n, Pascal.

A rare character gets a little more flair than a villager, and a
legendary one clearly the most. Common stays calm: most worktrees are
villagers, and the app is still a work tool. Rarity follows the
character, never the worktree (`raymond-2` is Raymond).

A villager's face is the same whatever their rarity. The rarer the
character, the more of Animal Crossing comes with their news when they
move in or out (`components/villagers`):

- **Common**: a toast with their face and catchphrase.
- **Rare**: an Animal Crossing dialogue box. A soft cream bubble, their
  name on a leaning plate in their own color (read off their face,
  `lib/villagers/faceColor.ts`), their words typed out a letter at a
  time, and the arrow bobbing once the line is out.
- **Legendary**: a letter on their own stationery
  (`lib/villagers/stationery.ts`, a pattern per character: music notes
  for K.K. Slider, stars for Celeste), and the biggest moment the app
  has. It arrives as a scene: the envelope's flap swings open and the
  letter rises out, their face drops onto a perforated stamp, a
  postmark presses the day's date over it as sparkles pop, the words
  write themselves onto lined paper, and the name signs itself with a
  swash, over the stationery drifting slowly.

Moving out is a goodbye, not an arrival in reverse: a regular
villager's face wears a moving box instead of the check, a rare one sits
packed in their box in the dialogue, and a legendary one's letter is a
farewell, with their photo taped in the corner in place of the stamp and
signed "Your friend". In a crowd (a Tidy run) the rare and legendary keep
their own moments, rarest on top, and the regulars share one toast.
Villagers moving one at a time join the news still showing about their
kind of move, so it grows rather than stacking, until it closes.

Everyday toasts (a commit) stay small for everyone: the face, and a
common villager's catchphrase. The dialogue box and the letter take
doubutsu's hard drop, like any floating surface. Under reduced motion every
moment is simply there, finished, and the drift holds while nobody is
looking or the machine is on battery.

And what they say scales the same way (`lib/villagerVoice.ts`):
regular villagers end a success with their catchphrase, and special
characters, who have none, speak through their quote (or, with none,
the move in their own words). News with a rarer character in it stays
on screen longer.

Rules that keep it consistent as features arrive:

- **A villager shows through `VillagerFace`**, never a bare
  `VillagerIcon` on a product surface, and a tier's moment is never
  re-inlined at a call site: it comes from `components/villagers`.
- **Only success speaks.** Warnings, errors and neutral notices stay
  plain.
- **Village news keeps to its own lane.** Moving in and out goes to
  its own toaster in the top-right corner (`VillageToaster`), never
  the bottom-right one, so it can't cover an error or an undo, and a
  click anywhere on it sends it away. A success said by a villager (a
  commit) answers something you did, so it stays in the everyday lane.
- **Anything that shows follows `useVillageLife`**, this window's
  switch, whichever device the worktree lives on, including toasts
  fired outside render (`lib/villagers/speakers.ts`). Nothing on a
  device reads it.
- **A moment happens whoever caused it.** Moving in and out is read off
  the worktree lists (`lib/villagers/moves.ts`), so the app, `sm` and
  another device all count. No emojis, and a name that isn't a
  character's shows nothing.

### Birthdays

A villager's birthday (their profile's, on the local calendar) is a
moment too, on every device's worktrees alike.

- **The name pick ignores them.** A new worktree's name is drawn at
  random as always: a birthday is celebrated where the villager already
  lives, never used to pick who moves in.
- **No announcement.** A birthday is found where the villager lives,
  not pushed as a toast: a daily one for every villager would repeat
  itself.
- **The sidebar row** wears a cake, their face in a party hat in its
  tooltip.
- **The worktree page** throws the party in its header, around the
  face beside the branch title (`BirthdayParty`), with no words: the
  face in a party hat throwing confetti under bunting for a regular
  villager, the bunting and a wash in their own color for a rare one,
  and for a legend balloons (one carrying a present), a bigger burst
  and their stationery.

### Visitors

Every villager who moves in is a visit, and Visitors (a section of
Settings while Village life shows) collects them like stickers in an
album.

- **Rarity scales the sticker** the way it scales the news: a regular
  villager's face on its tint, a special character's wash and name
  plate in their own color, a legend on their stationery with their
  face on a stamp. Every legend's slot shows from the start, as a
  silhouette, so the rarest are there to chase.
- **There is one best friend**, the villager met most, and only their
  sticker and the guest book say so.
