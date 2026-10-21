// Whether this window is being looked at right now, read from the
// document rather than the focus below, which knows nothing until its
// first event. The seed for anything that follows focus from boot: a
// window opened behind another must start unfocused.
export function documentFocused(): boolean {
  return document.hasFocus() && document.visibilityState === "visible";
}

// This window's focus as the boot follows it (boot.tsx followFocus),
// for what waits while nobody is looking: the animations `.unfocused`
// pauses, the hosts' sweeps, React Query's focus refetches and a
// failed view asked again on the way back.
const listeners = new Set<(focused: boolean) => void>();
let focused: boolean | undefined;

export function setWindowFocused(next: boolean): void {
  if (next === focused) return;
  focused = next;
  for (const listener of listeners) listener(next);
}

export function onWindowFocus(
  listener: (focused: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
