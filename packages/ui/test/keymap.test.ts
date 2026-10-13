// The keymap's table and its chords (src/lib/keymap.ts).
//
// Asserts:
//   1. Every default chord reads, and no two actions that can hear the
//      same keys share one, on macOS or elsewhere.
//   2. A chord matches the key press it names on each platform: `Mod`
//      is ⌘ on macOS and Ctrl elsewhere, Ctrl is Ctrl on both.
//   3. A device's bindings stand over the defaults, and one that does
//      not read, or names no action, is ignored.
//   4. A conflict names the action holding the keys in an overlapping
//      scope, and a page or a dialog of its own holds none.
//   5. A binding back on its default is stored as nothing, and the
//      section marks only the actions off theirs.
//   6. A letter or digit is the one the key types, the physical key
//      where the layout types no Latin one, every other key physical.
//   7. A ⌘ chord answers extra Shift, Alt or Ctrl unless another binding
//      takes that press, and the menu's defaults read before a window
//      sends its own.
//   8. On macOS the palette's, the commit's, the palette's changes' and
//      an edit's save also answer Ctrl in place of ⌘, rebound too,
//      unless another binding takes that press; no other chord does.
import { expect, it } from "vitest";
import {
  chordAccelerator,
  chordLabel,
  chordOfPress,
  chordText,
  conflictOf,
  menuAccelerators,
  KEYMAP_ACTIONS,
  keymapGroups,
  type Chord,
  type KeyPress,
  parseChord,
  resolveKeymap,
  withBinding,
} from "../src/lib/keymap.ts";

// A chord the test knows reads.
const chord = (text: string): Chord => {
  const read = parseChord(text);
  if (!read) throw new Error(`${text} does not read`);
  return read;
};

// A press on a US layout unless `key` says what the key typed.
const usKey = (code: string): string =>
  /^Key[A-Z]$/.test(code)
    ? code.slice(3).toLowerCase()
    : /^Digit\d$/.test(code)
      ? code.slice(5)
      : code;

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
  key: usKey(code),
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

it("reads every default and lets no two overlapping actions share one", () => {
  for (const mac of [true, false]) {
    const keymap = resolveKeymap(undefined, { mac, desktop: true });
    for (const action of KEYMAP_ACTIONS) {
      const own = chord(action.chord);
      expect(chordText(own)).toBe(action.chord);
      expect(conflictOf(keymap, action.id, own, mac)?.id, action.id).toBe(
        undefined,
      );
    }
  }
});

it("matches Mod to ⌘ on macOS and to Ctrl elsewhere", () => {
  const mac = resolveKeymap(undefined, { mac: true, desktop: true });
  const other = resolveKeymap(undefined, { mac: false, desktop: true });
  expect(mac.get("palette")?.matches(press("KeyK", { metaKey: true }))).toBe(
    true,
  );
  expect(mac.get("confirm")?.matches(press("Enter", { ctrlKey: true }))).toBe(
    false,
  );
  expect(other.get("palette")?.matches(press("KeyK", { ctrlKey: true }))).toBe(
    true,
  );
  // The terminal's toggle is Ctrl on both.
  for (const keymap of [mac, other]) {
    expect(
      keymap.get("terminal")?.matches(press("Backquote", { ctrlKey: true })),
    ).toBe(true);
  }
  expect(
    mac.get("terminal")?.matches(press("Backquote", { metaKey: true })),
  ).toBe(false);
  // A bare key wants no modifier.
  expect(mac.get("back")?.matches(press("Escape"))).toBe(true);
  expect(mac.get("back")?.matches(press("Escape", { shiftKey: true }))).toBe(
    false,
  );
  expect(mac.get("addProject")?.label).toBe("⇧⌘N");
  expect(other.get("addProject")?.label).toBe("Ctrl+Shift+N");
  expect(chordLabel(chord("Ctrl+Alt+Shift+L"), true)).toBe("⌃⌥⇧L");
  expect(mac.get("terminal")?.aria).toBe("Control+`");
  expect(chordAccelerator(chord("Mod+Shift+N"))).toBe("Cmd+Shift+N");
});

it("reads a press as a chord, the Windows key as none", () => {
  const digit = chordOfPress(press("Digit3", { metaKey: true }), true);
  expect(digit && chordText(digit)).toBe("Mod+3");
  expect(chordOfPress(press("ShiftLeft", { shiftKey: true }), true)).toBe(null);
  expect(chordOfPress(press("KeyK", { metaKey: true }), false)).toBe(null);
  const ctrl = chordOfPress(press("Backquote", { ctrlKey: true }), false);
  expect(ctrl && chordLabel(ctrl, false)).toBe("Ctrl+`");
});

it("stands a device's bindings over the defaults", () => {
  const keymap = resolveKeymap(
    { palette: "Mod+P", back: "Mod+Shift+", nothing: "Mod+J" },
    { mac: true, desktop: false },
  );
  expect(keymap.get("palette")?.label).toBe("⌘P");
  expect(keymap.get("back")?.label).toBe("Esc");
  expect(keymap.has("nothing")).toBe(false);
  // A web client has no menu.
  expect(keymap.has("newWindow")).toBe(false);
});

it("names the action holding the keys where they overlap", () => {
  const keymap = resolveKeymap(undefined, { mac: true, desktop: true });
  expect(conflictOf(keymap, "terminal", chord("Mod+K"), true)?.id).toBe(
    "palette",
  );
  // The palette's and the folder pickers' ⌘↩ hear different dialogs.
  expect(conflictOf(keymap, "commit", chord("Mod+Enter"), true)).toBe(
    undefined,
  );
  // The window hears every page.
  expect(conflictOf(keymap, "palette", chord("Mod+Enter"), true)?.id).toBe(
    "commit",
  );
});

it("stores only what differs from the defaults", () => {
  const stored = withBinding({}, "palette", chord("Mod+P"));
  expect(stored).toEqual({ palette: "Mod+P" });
  expect(withBinding(stored, "palette", chord("Mod+K"))).toEqual({});
  expect(withBinding(stored, "palette", null)).toEqual({});
  const rows = keymapGroups(
    resolveKeymap(stored, { mac: true, desktop: true }),
  ).flatMap((group) => group.rows);
  expect(rows.filter((row) => row.own).map((row) => row.id)).toEqual([
    "palette",
  ]);
  expect(rows.find((row) => row.id === "palette")?.keys).toBe("⌘P");
});

it("reads a letter or digit as typed, the physical key where no Latin one is typed", () => {
  const mac = resolveKeymap(undefined, { mac: true, desktop: true });
  const palette = mac.get("palette");
  // Dvorak: the key QWERTY calls V types k.
  expect(palette?.matches(press("KeyV", { key: "k", metaKey: true }))).toBe(
    true,
  );
  // ...and the key in K's place types t, which is not ⌘K.
  expect(palette?.matches(press("KeyK", { key: "t", metaKey: true }))).toBe(
    false,
  );
  // Cyrillic types л on K's key: no Latin letter, so the key itself.
  expect(palette?.matches(press("KeyK", { key: "л", metaKey: true }))).toBe(
    true,
  );
  // ⌥ composing a symbol on K's key: the key itself.
  expect(
    chordOfPress(press("KeyK", { key: "˚", altKey: true, metaKey: true }), true)
      ?.key,
  ).toBe("K");
  // Dvorak's ' where QWERTY has Q names no letter.
  expect(chordOfPress(press("KeyQ", { key: "'", metaKey: true }), true)).toBe(
    null,
  );
  // ⇧1 types ! and is still the digit.
  expect(
    chordOfPress(press("Digit1", { key: "!", shiftKey: true }), true)?.key,
  ).toBe("1");
  // The terminal's Ctrl+` is the key left of 1, whatever it types.
  expect(
    mac
      .get("terminal")
      ?.matches(press("Backquote", { key: "^", ctrlKey: true })),
  ).toBe(true);
});

it("answers a ⌘ chord with extra modifiers unless another binding takes the press", () => {
  const mac = resolveKeymap(undefined, { mac: true, desktop: true });
  const enterWith = (mods: Partial<KeyPress>) =>
    press("Enter", { key: "Enter", metaKey: true, ...mods });
  expect(mac.get("commit")?.matches(enterWith({ shiftKey: true }))).toBe(true);
  expect(mac.get("commit")?.matches(enterWith({ altKey: true }))).toBe(true);
  expect(
    mac
      .get("palette")
      ?.matches(press("KeyK", { metaKey: true, ctrlKey: true })),
  ).toBe(true);
  // ⇧⌘N is Add project's own: New window does not take it too.
  const shifted = press("KeyN", { key: "N", metaKey: true, shiftKey: true });
  expect(mac.get("addProject")?.matches(shifted)).toBe(true);
  expect(mac.get("newWindow")?.matches(shifted)).toBe(false);
  // A missing modifier is no match.
  expect(mac.get("addProject")?.matches(press("KeyN", { metaKey: true }))).toBe(
    false,
  );
});

it("gives the menu the device's accelerators before a window sends its own", () => {
  const moved = menuAccelerators({ newWindow: "Mod+Shift+M" });
  expect(moved.newWindow).toBe("Cmd+Shift+M");
  const defaults = menuAccelerators(undefined);
  expect(defaults.settings).toBe("Cmd+,");
  expect(defaults.newWindow).toBe("Cmd+N");
  expect(defaults.addProject).toBe("Cmd+Shift+N");
  expect(defaults.launchTool1).toBe("Cmd+1");
  expect(defaults.palette).toBe(undefined);
});

it("takes a letter as typed on any key, the physical key with Alt held, and AltGr as no extra", () => {
  const mac = resolveKeymap(undefined, { mac: true, desktop: true });
  const other = resolveKeymap(undefined, { mac: false, desktop: true });
  // AZERTY types M on the key QWERTY calls ;.
  expect(
    chordOfPress(press("Semicolon", { key: "m", metaKey: true }), true)?.key,
  ).toBe("M");
  // A German Mac's ⌥L types @: still L.
  expect(
    chordOfPress(press("KeyL", { key: "@", altKey: true, metaKey: true }), true)
      ?.key,
  ).toBe("L");
  // Windows AltGr (Ctrl+Alt) typing ł on K is no palette.
  expect(
    other
      .get("palette")
      ?.matches(press("KeyK", { key: "ł", ctrlKey: true, altKey: true })),
  ).toBe(false);
  // A binding out of reach takes nothing: ⇧⌘↩ still commits with the
  // palette's changes moved onto it.
  const moved = resolveKeymap(
    { paletteChanges: "Mod+Shift+Enter" },
    { mac: true, desktop: true },
  );
  expect(
    moved
      .get("commit")
      ?.matches(
        press("Enter", { key: "Enter", metaKey: true, shiftKey: true }),
      ),
  ).toBe(true);
  expect(mac.get("palette")).toBeDefined();
});

it("answers the Ctrl twins on macOS, and no other action's", () => {
  const mac = resolveKeymap(undefined, { mac: true, desktop: true });
  expect(mac.get("palette")?.matches(press("KeyK", { ctrlKey: true }))).toBe(
    true,
  );
  for (const id of ["commit", "paletteChanges", "save"]) {
    expect(
      mac.get(id)?.matches(press("Enter", { key: "Enter", ctrlKey: true })),
      id,
    ).toBe(true);
  }
  // Exactly Ctrl for ⌘: no extras, and not on a Ctrl chord's own.
  expect(
    mac
      .get("palette")
      ?.matches(press("KeyK", { ctrlKey: true, shiftKey: true })),
  ).toBe(false);
  for (const action of KEYMAP_ACTIONS) {
    if (action.ctrlTwin) continue;
    const own = chord(action.chord);
    if (!own.mod) continue;
    const key = own.key.length === 1 ? own.key.toLowerCase() : own.key;
    const code = /^[A-Z]$/.test(own.key)
      ? `Key${own.key}`
      : /^\d$/.test(own.key)
        ? `Digit${own.key}`
        : own.key === ","
          ? "Comma"
          : own.key;
    expect(
      mac.get(action.id)?.matches(
        press(code, {
          key,
          ctrlKey: true,
          altKey: own.alt,
          shiftKey: own.shift,
        }),
      ),
      action.id,
    ).toBe(false);
  }
  // Rebound, the twin follows the chord.
  const moved = resolveKeymap(
    { palette: "Mod+P" },
    { mac: true, desktop: true },
  );
  expect(moved.get("palette")?.matches(press("KeyP", { ctrlKey: true }))).toBe(
    true,
  );
  expect(moved.get("palette")?.matches(press("KeyK", { ctrlKey: true }))).toBe(
    false,
  );
  // A binding of its own on Ctrl+K takes the press from the twin.
  const taken = resolveKeymap(
    { sidebarLayout: "Ctrl+K" },
    { mac: true, desktop: true },
  );
  expect(taken.get("palette")?.matches(press("KeyK", { ctrlKey: true }))).toBe(
    false,
  );
  expect(
    taken.get("sidebarLayout")?.matches(press("KeyK", { ctrlKey: true })),
  ).toBe(true);
});
