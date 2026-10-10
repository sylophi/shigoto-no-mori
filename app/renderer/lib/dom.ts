// True when a keydown originated in a text-entry context (input,
// textarea, or contenteditable), which keeps every key but a `Mod`
// chord (hooks/ui/useKeymap.ts).
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

// True when a keydown originated in a surface that consumes raw keys
// itself: a terminal, where Ctrl+D is EOF and Ctrl+C an interrupt for
// the running program. It keeps every key a shell can be sent, and the
// keymap claims the few it gives up before it sees them. Surfaces opt in
// with data-keyboard-surface="raw".
export function isRawKeySurface(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-keyboard-surface="raw"]') !== null
  );
}

// True while something is layered over the page and owns the keyboard:
// a modal shell, a sheet, an open menu, popover or combobox popup, or
// the blocking veil. The keymap's listener hears a key wherever focus
// sits, a dialog's trapped focus included, so it asks. One
// still animating out (data-closed, on it or around it) has already
// let go.
const OVERLAY_SLOTS = [
  "modal-shell",
  "sheet-content",
  "dropdown-menu-content",
  "popover-content",
  "combobox-popup",
  "blocking-overlay",
]
  .map((slot) => `[data-slot="${slot}"]:not([data-closed], [data-closed] *)`)
  .join(", ");

export function isOverlayOpen(): boolean {
  return Boolean(document.querySelector(OVERLAY_SLOTS));
}
