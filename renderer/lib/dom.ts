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

// True while a full-app overlay is up (the project launcher, any modal
// shell). Neither traps focus and both mount as siblings of the router,
// so a bare-key shortcut in the page underneath still fires unless it
// asks. Distinct from the launcher's own narrower check, which asks only
// "is a modal up" to decide whether it may open on top.
export function isOverlayOpen(): boolean {
  return Boolean(
    document.querySelector('[data-slot="launcher"], [data-slot="modal-shell"]'),
  );
}
