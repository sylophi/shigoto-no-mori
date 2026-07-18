// True when a keydown originated in a text-entry context (input,
// textarea, or contenteditable) — bare-key window shortcuts must stay
// inert there. Shared by every global hotkey so the definition of
// "the user is typing" can't drift between them.
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
