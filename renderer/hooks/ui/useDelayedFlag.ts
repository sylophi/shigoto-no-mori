import { useEffect, useState } from "react";

// Shows `true` only when `active` has been continuously on for at least
// `delayMs`. Used to suppress sub-second indicator flicker on quick
// refetches: if `active` flips on then off inside the delay window, the
// hook never reports `true`.
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [visible, setVisible] = useState(false);

  // Reset during render (not in an effect) so consumers never commit a
  // frame where `active` is off but the flag still reads `true`.
  if (!active && visible) setVisible(false);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      setVisible(true);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [active, delayMs]);

  return visible;
}
