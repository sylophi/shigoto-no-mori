// The one breakpoint the shell lays out on, and the phone layout it
// decides: the theme root under 48rem wide, the width the stylesheet's
// `web` container query switches the phone styles at (phone.css). Here
// it is a real render gate rather than a CSS `hidden`: the wide layout
// mounts the static sidebar, which runs the full forest query fan-out,
// and a phone-width session must not pay for a permanently invisible
// copy of it.
import { useSyncExternalStore } from "react";
import { hasLocalHost } from "@/lib/localHost";
import { themeRoot } from "@/lib/themeRoot";

const PHONE_BELOW_PX = 768;

function subscribeToRootWidth(onChange: () => void): () => void {
  const observer = new ResizeObserver(onChange);
  observer.observe(themeRoot());
  return () => observer.disconnect();
}

// The desktop window never takes the phone layout: its minimum width
// sits below the breakpoint, and a folded sidebar would put its toggle
// under the traffic lights. There the answer is a constant, so nothing
// subscribes.
const subscribeToNothing = () => () => {};

// The phone layout: a bottom tab bar, the forest as a page of its own,
// and the worktree pages stacked over it. Only ever the browser tab's.
export function isPhoneLayout(): boolean {
  return (
    !hasLocalHost && themeRoot().getBoundingClientRect().width < PHONE_BELOW_PX
  );
}

export function usePhoneLayout(): boolean {
  return useSyncExternalStore(
    hasLocalHost ? subscribeToNothing : subscribeToRootWidth,
    isPhoneLayout,
  );
}
