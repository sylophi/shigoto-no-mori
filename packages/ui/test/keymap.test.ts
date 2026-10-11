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
import { expect, it } from "vitest";
import {
  chordAccelerator,
  chordLabel,
  chordOfPress,
  chordText,
  conflictOf,
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

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
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
  expect(mac.get("palette")?.matches(press("KeyK", { ctrlKey: true }))).toBe(
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
