// The one viewport breakpoint the shell lays out on, and the phone
// layout it decides. Tailwind's md (48rem) as a real render gate rather
// than a CSS `hidden`: the wide layout mounts the static sidebar, which
// runs the full forest query fan-out, and a phone-width session must
// not pay for a permanently invisible copy of it. One MediaQueryList
// for both the subscription and the snapshot, created on first use so
// importing this module needs no window. The same breakpoint is read
// pre-paint by web/public/boot-theme.js, which stamps the layout onto
// <html> so the `phone:` utilities hold from the first frame.
import { useSyncExternalStore } from "react";
import { hasLocalHost } from "@/lib/localHost";

let wideMedia: MediaQueryList | null = null;
const wideQuery = () => (wideMedia ??= window.matchMedia("(min-width: 48rem)"));

function subscribeToWide(onChange: () => void): () => void {
  wideQuery().addEventListener("change", onChange);
  return () => wideQuery().removeEventListener("change", onChange);
}

// The desktop window never takes the phone layout: its minimum width
// sits below the breakpoint, and a folded sidebar would put its toggle
// under the traffic lights. There the answer is a constant, so nothing
// subscribes.
const subscribeToNothing = () => () => {};

// The phone layout: a bottom tab bar, the forest as a page of its own,
// and the worktree pages stacked over it. Only ever the browser tab's.
export function isPhoneLayout(): boolean {
  return !hasLocalHost && !wideQuery().matches;
}

export function usePhoneLayout(): boolean {
  return useSyncExternalStore(
    hasLocalHost ? subscribeToNothing : subscribeToWide,
    isPhoneLayout,
  );
}
