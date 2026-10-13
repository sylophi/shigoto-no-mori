// The app's keymap: every key it answers, as a named action with its
// words, its default chord and the scope it acts in (V3.md, "The
// keymap"). The menu's accelerators, the palette's verbs, the rows'
// hints and the window's listener all read this table, through the
// device's bindings (`keybindings` in the client config). A control's
// own keys (Enter in a field, the arrows in a list, Escape out of a
// dialog) are the control's and stay out, and so are the switches for
// what is still an experiment: the dev builds' theme keys and the
// palettes' hidden variants (usePaletteVariantHotkey).
//
// A chord is written once: `Mod` is ⌘ on macOS and Ctrl elsewhere. A
// letter or a digit is the one the key types, whichever key types it, as
// the app's shortcuts always were: ⌘K on Dvorak or Colemak is the key
// that types K, ⌘M on AZERTY the key that types M. With Alt held (⌥
// composing a symbol, AltGr typing a layout's third character), or
// where the layout types no Latin letter or digit (Cyrillic, Greek),
// it is the physical key, named as on a US keyboard
// (`KeyboardEvent.code`), as macOS's own ⌘ shortcuts fall back. Every
// other key is the physical one: the terminal's Ctrl+` names the key
// left of 1, which many layouts type no backtick on. A ⌘ chord also
// answers extra modifiers (bindingOf), and the palette's also answers
// Ctrl in place of ⌘ on macOS, as it always did (⌃K is ⌘K); no other
// chord has a Ctrl twin.

// Where an action acts. The window is every page; a page or a dialog
// is only itself, so two of them can share a chord.
type KeymapScope =
  | "window"
  | "worktree"
  | "changes"
  | "palette"
  | "folders"
  | "editing";

const SCOPE_LABELS: Readonly<Record<KeymapScope, string>> = {
  window: "Anywhere",
  worktree: "A worktree's page",
  changes: "Changes",
  palette: "The palette",
  folders: "Adding a project, picking a folder",
  editing: "Editing a description or a commit's message",
};

export interface KeymapAction {
  readonly id: string;
  readonly label: string;
  readonly chord: string;
  readonly scope: KeymapScope;
  // The shell's menu runs it, so only the desktop app has it.
  readonly menu?: true;
  // A focused terminal gives it up, as it gives up nothing else.
  readonly terminal?: true;
  // On macOS its `Mod` chord also answers Ctrl in place of ⌘.
  readonly ctrlTwin?: true;
}

const launchTool = (n: number): KeymapAction => ({
  id: `launchTool${n}`,
  label: `Launch tool ${n}`,
  chord: `Mod+${n}`,
  scope: "window",
  menu: true,
});

export const KEYMAP_ACTIONS: readonly KeymapAction[] = [
  {
    id: "palette",
    label: "Open or close the palette",
    chord: "Mod+K",
    scope: "window",
    ctrlTwin: true,
  },
  {
    id: "newWindow",
    label: "New window",
    chord: "Mod+N",
    scope: "window",
    menu: true,
  },
  {
    id: "addProject",
    label: "Add a project",
    chord: "Mod+Shift+N",
    scope: "window",
    menu: true,
  },
  {
    id: "settings",
    label: "Settings",
    chord: "Mod+,",
    scope: "window",
    menu: true,
  },
  { id: "back", label: "Go back", chord: "Escape", scope: "window" },
  {
    id: "sidebarLayout",
    label: "Switch the sidebar's layout",
    chord: "Tab",
    scope: "window",
  },
  // Ctrl on every platform: ⌘` cycles an app's windows on macOS.
  {
    id: "terminal",
    label: "Show or hide the terminal",
    chord: "Ctrl+`",
    scope: "worktree",
    terminal: true,
  },
  {
    id: "commit",
    label: "Commit, or push with nothing to commit",
    chord: "Mod+Enter",
    scope: "changes",
  },
  {
    id: "paletteChanges",
    label: "Open the worktree's changes",
    chord: "Mod+Enter",
    scope: "palette",
  },
  // Past the highlighted row: the folder typed, or the repos picked.
  {
    id: "confirm",
    label: "Add or pick what is typed",
    chord: "Mod+Enter",
    scope: "folders",
  },
  {
    id: "save",
    label: "Save what is being edited",
    chord: "Mod+Enter",
    scope: "editing",
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(launchTool),
];

const actionOf = (id: string): KeymapAction | undefined =>
  KEYMAP_ACTIONS.find((action) => action.id === id);

// Two actions can hear the same keys when one acts anywhere or both act
// in the same place.
const scopesOverlap = (a: KeymapScope, b: KeymapScope): boolean =>
  a === b || a === "window" || b === "window";

// ---- chords ----

export interface Chord {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly key: string;
}

// The keys a chord can end in, by their `code`, under the name a chord
// is written with. Letters and digits are added below.
const NAMED_CODES: Readonly<Record<string, string>> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

// The key a `code` names, or null for one a chord can't end in (a
// modifier on its own, a media key).
function keyOfCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1] ?? null;
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return NAMED_CODES[code] ?? null;
}

// The key a press names: a letter or digit as typed, where the layout
// types one, the physical key otherwise (the header says why).
function keyOfPress(e: KeyPress): string | null {
  const physical = keyOfCode(e.code);
  const typed = e.key.length === 1 ? e.key.toUpperCase() : "";
  // ⌥ composes a symbol on a Mac, and AltGr types a layout's third
  // character elsewhere: with Alt held the key is the physical one.
  if (/^[A-Z0-9]$/.test(typed) && !e.altKey) return typed;
  if (!/^(Key[A-Z]|Digit\d)$/.test(e.code)) return physical;
  // Shift on a digit types its symbol (⇧1 is !), and with Alt held, or
  // a layout typing another script there, the key is itself.
  if (e.altKey || typed === "" || e.code.startsWith("Digit")) return physical;
  // A letter key typing ASCII punctuation (Dvorak's ' where QWERTY has
  // Q) names no letter; one typing another script is the key itself.
  return typed.charCodeAt(0) < 128 ? null : physical;
}

const KEYS = new Set([
  ...Object.values(NAMED_CODES),
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

// "Mod+Shift+N" to a chord, or null for one that isn't.
export function parseChord(text: string): Chord | null {
  const parts = text.split("+");
  // "Mod++" would be a plus key, which no chord ends in; "+" splits a
  // trailing empty part off instead.
  const key = parts.pop();
  if (key === undefined || !KEYS.has(key)) return null;
  const mods = new Set(parts);
  if (mods.size !== parts.length) return null;
  for (const mod of mods) {
    if (!["Mod", "Ctrl", "Alt", "Shift"].includes(mod)) return null;
  }
  return {
    mod: mods.has("Mod"),
    ctrl: mods.has("Ctrl"),
    alt: mods.has("Alt"),
    shift: mods.has("Shift"),
    key,
  };
}

// A chord as it is stored, the modifiers in one order.
export function chordText(chord: Chord): string {
  return [
    chord.mod && "Mod",
    chord.ctrl && "Ctrl",
    chord.alt && "Alt",
    chord.shift && "Shift",
    chord.key,
  ]
    .filter(Boolean)
    .join("+");
}

// The keys a chord presses on this platform: Ctrl and `Mod` are one
// key off macOS.
interface Pressed {
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly key: string;
}

function pressed(chord: Chord, mac: boolean): Pressed {
  return {
    meta: mac && chord.mod,
    ctrl: chord.ctrl || (!mac && chord.mod),
    alt: chord.alt,
    shift: chord.shift,
    key: chord.key,
  };
}

const samePressed = (a: Pressed, b: Pressed): boolean =>
  a.meta === b.meta &&
  a.ctrl === b.ctrl &&
  a.alt === b.alt &&
  a.shift === b.shift &&
  a.key === b.key;

// The fields of a key event a chord is read from.
export interface KeyPress {
  readonly code: string;
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

// The chord a key press makes, or null for one that makes none: a
// modifier alone, or the Windows key off macOS.
export function chordOfPress(e: KeyPress, mac: boolean): Chord | null {
  const key = keyOfPress(e);
  if (key === null || (!mac && e.metaKey)) return null;
  return {
    mod: mac ? e.metaKey : e.ctrlKey,
    ctrl: mac && e.ctrlKey,
    alt: e.altKey,
    shift: e.shiftKey,
    key,
  };
}

const MAC_KEYS: Readonly<Record<string, string>> = {
  Enter: "↩",
  Escape: "Esc",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

const OTHER_KEYS: Readonly<Record<string, string>> = {
  Escape: "Esc",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
};

// A chord as the screen shows it: the Mac's glyphs (⌃⌥⇧⌘K) on macOS,
// names joined with + elsewhere.
export function chordLabel(chord: Chord, mac: boolean): string {
  const keys = pressed(chord, mac);
  if (mac) {
    return [
      keys.ctrl && "⌃",
      keys.alt && "⌥",
      keys.shift && "⇧",
      keys.meta && "⌘",
      MAC_KEYS[keys.key] ?? keys.key,
    ]
      .filter(Boolean)
      .join("");
  }
  return [
    keys.ctrl && "Ctrl",
    keys.alt && "Alt",
    keys.shift && "Shift",
    OTHER_KEYS[keys.key] ?? keys.key,
  ]
    .filter(Boolean)
    .join("+");
}

const ARIA_KEYS: Readonly<Record<string, string>> = {
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
};

// A chord for `aria-keyshortcuts`.
function chordAria(chord: Chord, mac: boolean): string {
  const keys = pressed(chord, mac);
  return [
    keys.ctrl && "Control",
    keys.alt && "Alt",
    keys.shift && "Shift",
    keys.meta && "Meta",
    ARIA_KEYS[keys.key] ?? keys.key,
  ]
    .filter(Boolean)
    .join("+");
}

// A chord as an Electron accelerator, for the shell's menu, which is
// macOS's alone.
export function chordAccelerator(chord: Chord): string {
  return [
    chord.mod && "Cmd",
    chord.ctrl && "Ctrl",
    chord.alt && "Alt",
    chord.shift && "Shift",
    chord.key,
  ]
    .filter(Boolean)
    .join("+");
}

// ---- a window's keymap ----

// An action's chord as this window binds it, ready to show and to match.
export interface Binding {
  readonly chord: Chord;
  // What the screen shows (⌘K).
  readonly label: string;
  // For `aria-keyshortcuts`.
  readonly aria: string;
  readonly matches: (e: KeyPress) => boolean;
}

export function bindingOf(
  chord: Chord,
  mac: boolean,
  // The presses other bindings in reach of this one take as their own,
  // which this one gives up when it answers extra modifiers or its twin.
  taken: readonly Pressed[] = [],
  // Whether Ctrl in place of ⌘ answers too (KeymapAction's ctrlTwin).
  ctrlTwin = false,
): Binding {
  const keys = pressed(chord, mac);
  const twin: Pressed | null =
    ctrlTwin && keys.meta && !keys.ctrl
      ? { ...keys, meta: false, ctrl: true }
      : null;
  return {
    chord,
    label: chordLabel(chord, mac),
    aria: chordAria(chord, mac),
    matches: (e) => {
      const press = chordOfPress(e, mac);
      if (press === null) return false;
      const held = pressed(press, mac);
      if (samePressed(held, keys)) return true;
      if (twin && samePressed(held, twin)) {
        return !taken.some((other) => samePressed(other, held));
      }
      // A ⌘ chord also answers the same press with Shift, Alt or Ctrl
      // held as well, as the app's ⌘K and ⌘↩ always did, unless another
      // binding in reach takes that press (⇧⌘N is Add project, not New
      // window). Ctrl and Alt together off a Mac are AltGr typing a
      // character, never a chord's extra.
      return (
        chord.mod &&
        held.key === keys.key &&
        (!keys.meta || held.meta) &&
        (!keys.ctrl || held.ctrl) &&
        (!keys.alt || held.alt) &&
        (!keys.shift || held.shift) &&
        (mac || !(held.ctrl && held.alt) || (keys.ctrl && keys.alt)) &&
        !taken.some((other) => samePressed(other, held))
      );
    },
  };
}

// The device's bindings over the defaults: an action's own chord where
// one is stored and reads, its default otherwise. `desktop` keeps the
// menu's actions, which a web client has no menu for.
export function resolveKeymap(
  stored: Readonly<Record<string, string>> | undefined,
  { mac, desktop }: { mac: boolean; desktop: boolean },
): ReadonlyMap<string, Binding> {
  const chords = new Map<KeymapAction, Chord>();
  for (const action of KEYMAP_ACTIONS) {
    if (action.menu && !desktop) continue;
    const own = stored?.[action.id];
    const chord =
      (own === undefined ? null : parseChord(own)) ?? parseChord(action.chord);
    if (chord) chords.set(action, chord);
  }
  const keymap = new Map<string, Binding>();
  for (const [action, chord] of chords) {
    const taken = [...chords]
      .filter(
        ([other]) =>
          other !== action && scopesOverlap(action.scope, other.scope),
      )
      .map(([, held]) => pressed(held, mac));
    keymap.set(
      action.id,
      bindingOf(chord, mac, taken, action.ctrlTwin === true),
    );
  }
  return keymap;
}

// The menu's chords as accelerators, for the shell's menu before a
// window has sent its own: the device's bindings over the defaults.
export function menuAccelerators(
  stored: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const accelerators: Record<string, string> = {};
  const keymap = resolveKeymap(stored, { mac: true, desktop: true });
  for (const action of KEYMAP_ACTIONS) {
    const binding = action.menu ? keymap.get(action.id) : undefined;
    if (binding) accelerators[action.id] = chordAccelerator(binding.chord);
  }
  return accelerators;
}

// The default bindings, for a scene: a Mac's, as the fixtures are.
const DEFAULT_KEYMAP = resolveKeymap(undefined, {
  mac: true,
  desktop: true,
});

// A default binding, for a scene.
export function defaultBinding(id: string): Binding {
  const binding = DEFAULT_KEYMAP.get(id);
  if (!binding) throw new Error(`No action ${id} in the keymap`);
  return binding;
}

// The action already holding `chord` where `id` would hear it, if any.
export function conflictOf(
  keymap: ReadonlyMap<string, Binding>,
  id: string,
  chord: Chord,
  mac: boolean,
): KeymapAction | undefined {
  const action = actionOf(id);
  if (!action) return undefined;
  const keys = pressed(chord, mac);
  return KEYMAP_ACTIONS.find((other) => {
    if (other.id === id || !scopesOverlap(action.scope, other.scope)) {
      return false;
    }
    const held = keymap.get(other.id);
    return held !== undefined && samePressed(pressed(held.chord, mac), keys);
  });
}

// ---- the Keyboard section ----

interface KeymapRow {
  readonly id: string;
  readonly label: string;
  // Its keys as the screen shows them.
  readonly keys: string;
  // Bound to its own chord rather than its default.
  readonly own: boolean;
}

export interface KeymapGroup {
  readonly label: string;
  readonly rows: readonly KeymapRow[];
}

// The section's rows, every action `keymap` has, by scope in the
// table's order.
export function keymapGroups(
  keymap: ReadonlyMap<string, Binding>,
): KeymapGroup[] {
  const groups = new Map<KeymapScope, KeymapRow[]>();
  for (const action of KEYMAP_ACTIONS) {
    const binding = keymap.get(action.id);
    if (!binding) continue;
    const rows = groups.get(action.scope) ?? [];
    rows.push({
      id: action.id,
      label: action.label,
      keys: binding.label,
      own: chordText(binding.chord) !== action.chord,
    });
    groups.set(action.scope, rows);
  }
  return [...groups].map(([scope, rows]) => ({
    label: SCOPE_LABELS[scope],
    rows,
  }));
}

// The stored bindings with `id` on `chord`: nothing kept for a default.
export function withBinding(
  stored: Readonly<Record<string, string>>,
  id: string,
  chord: Chord | null,
): Record<string, string> {
  const { [id]: _dropped, ...rest } = stored;
  const action = actionOf(id);
  if (!chord || !action || chordText(chord) === action.chord) return rest;
  return { ...rest, [id]: chordText(chord) };
}
