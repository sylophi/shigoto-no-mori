// The one breakpoint the shell lays out on, and the phone layout it
// decides: the theme root under 48rem wide, the width the stylesheet's
// `web` container query switches the phone styles at (phone.css). Here
// it is a real render gate rather than a CSS `hidden`: the wide layout
// mounts the static sidebar, which runs the full forest query fan-out,
// and a phone-width session must not pay for a permanently invisible
// copy of it.
import { useSyncExternalStore } from "react";
import {
  createExternalStore,
  type ExternalStore,
} from "@shigomori/ui/lib/externalStore.ts";
import { hasLocalHost } from "@/lib/localHost";
import { useWindowRoot } from "@/lib/themeRoot";

const PHONE_BELOW_PX = 768;

// One observer per window's root, as a root lives as long as its
// window, made on first use so importing this module needs no window.
// Readers get the last answer rather than a fresh layout read each
// render.
const phoneStores = new WeakMap<HTMLElement, ExternalStore<boolean>>();
function rootIsNarrow(root: HTMLElement): ExternalStore<boolean> {
  const known = phoneStores.get(root);
  if (known) return known;
  const narrow = () => root.getBoundingClientRect().width < PHONE_BELOW_PX;
  const store = createExternalStore(narrow());
  new ResizeObserver(() => {
    const next = narrow();
    if (next !== store.get()) store.publish(next);
  }).observe(root);
  phoneStores.set(root, store);
  return store;
}

// The desktop window never takes the phone layout: its minimum width
// sits below the breakpoint, and a folded sidebar would put its toggle
// under the traffic lights. There the answer is a constant, so nothing
// subscribes.
const subscribeToNothing = () => () => {};

// The phone layout: a bottom tab bar, the forest as a page of its own,
// and the worktree pages stacked over it. Only ever the browser tab's.
export function isPhoneLayout(root: HTMLElement): boolean {
  return !hasLocalHost && rootIsNarrow(root).get();
}

export function usePhoneLayout(): boolean {
  const root = useWindowRoot();
  return useSyncExternalStore(
    hasLocalHost
      ? subscribeToNothing
      : (onChange) => rootIsNarrow(root).subscribe(onChange),
    () => isPhoneLayout(root),
  );
}
