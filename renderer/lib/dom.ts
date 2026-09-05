// True when a keydown originated in a text-entry context (input,
// textarea, or contenteditable). Bare-key window shortcuts must stay
// inert there. Shared by every global hotkey so the definition of
// "the user is typing" can't drift between them.
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

// True when a keydown originated in a surface that consumes raw keys
// itself: the script console's terminal, where Ctrl+D is EOF and Ctrl+C
// an interrupt for the running program. Such surfaces are text fields
// too (isEditableTarget covers them, so bare-key shortcuts stay inert),
// but a hotkey whose key would otherwise be passed through as a control
// byte can check this to claim it instead. Surfaces opt in with
// data-keyboard-surface="raw".
export function isRawKeySurface(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-keyboard-surface="raw"]') !== null
  );
}

// True while something is layered over the page and owns the keyboard:
// the launcher, a modal shell, a sheet, an open menu or combobox popup,
// or the blocking veil. None of them trap focus (they mount as siblings
// of the router, and the popups portal out), so a bare-key shortcut in
// the page underneath still fires unless it asks. Distinct from the
// launcher's own narrower check, which asks only "is a modal up" to
// decide whether it may open on top.
const OVERLAY_SLOTS = [
  "launcher",
  "modal-shell",
  "sheet-content",
  "dropdown-menu-content",
  "combobox-popup",
  "blocking-overlay",
]
  .map((slot) => `[data-slot="${slot}"]`)
  .join(", ");

export function isOverlayOpen(): boolean {
  return Boolean(document.querySelector(OVERLAY_SLOTS));
}

// The full "may a bare-key shortcut act right now" test: no modifiers,
// not a key-repeat or an IME composition, not typing, and no overlay
// covering the page. Composed here rather than at each listener so the
// guard set stays uniform. Adding a condition later is one edit, not an
// audit of every hotkey. Shortcuts that deliberately want a narrower
// rule (the launcher's backtick closes even from its own search field)
// keep their own check and say why.
export function isBareKeyEvent(e: KeyboardEvent): boolean {
  if (e.repeat || e.isComposing) return false;
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (isEditableTarget(e.target)) return false;
  return !isOverlayOpen();
}
