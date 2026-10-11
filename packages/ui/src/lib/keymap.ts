// The app's keymap: every key it answers, as a named action with its
// words, its default chord and the scope it acts in (V3.md, "The
// keymap"). The menu's accelerators, the palette's verbs, the rows'
// hints and the window's listener all read this table, through the
// device's bindings (`keybindings` in the client config). A control's
// own keys (Enter in a field, the arrows in a list, Escape out of a
// dialog) are the control's and stay out.
//
// A chord is written once: `Mod` is ⌘ on macOS and Ctrl elsewhere, and
// the key is the physical one, named as on a US keyboard
// (`KeyboardEvent.code`), so a chord holds on any layout and with ⌥ held.

// Where an action acts. The window is every page; a page or a dialog
// is only itself, so two of them can share a chord.
type KeymapScope = "window" | "worktree" | "changes" | "palette" | "folders";

export interface KeymapAction {
  readonly id: string;
  readonly label: string;
  readonly chord: string;
  readonly scope: KeymapScope;
  // The shell's menu runs it, so only the desktop app has it.
  readonly menu?: true;
  // A focused terminal gives it up, as it gives up nothing else.
  readonly terminal?: true;
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
  {
    id: "paletteVariant",
    label: "Next variant of the light palette",
    chord: "Ctrl+Alt+Shift+L",
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
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

// The chord a key press makes, or null for one that makes none: a
// modifier alone, or the Windows key off macOS.
export function chordOfPress(e: KeyPress, mac: boolean): Chord | null {
  const key = keyOfCode(e.code);
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

function bindingOf(chord: Chord, mac: boolean): Binding {
  const keys = pressed(chord, mac);
  return {
    chord,
    label: chordLabel(chord, mac),
    aria: chordAria(chord, mac),
    matches: (e) => {
      const press = chordOfPress(e, mac);
      return press !== null && samePressed(pressed(press, mac), keys);
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
  const keymap = new Map<string, Binding>();
  for (const action of KEYMAP_ACTIONS) {
    if (action.menu && !desktop) continue;
    const own = stored?.[action.id];
    const chord =
      (own === undefined ? null : parseChord(own)) ?? parseChord(action.chord);
    if (chord) keymap.set(action.id, bindingOf(chord, mac));
  }
  return keymap;
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
