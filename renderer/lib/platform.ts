// Display glyphs for modifiers, matching the accelerators the menu
// registers.
export const modKey = "⌘";
export const shiftKey = "⇧";

// Human-readable shortcut joined the way macOS writes it: "⌘N".
export function shortcutLabel(...keys: string[]): string {
  return keys.join("");
}

export const fileManagerName = "Finder";
