// Whether this window is being looked at right now, read from the
// document rather than React Query's focusManager, which assumes focus
// until its first event. The seed for anything that follows focus from
// boot: a window opened behind another must start unfocused.
export function documentFocused(): boolean {
  return document.hasFocus() && document.visibilityState === "visible";
}
