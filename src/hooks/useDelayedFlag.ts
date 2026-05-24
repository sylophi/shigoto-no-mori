import { useEffect, useRef, useState } from "react";

// Shows `true` only when `active` has been continuously on for at least
// `delayMs`. Used to suppress sub-second indicator flicker on quick
// refetches: if `active` flips on then off inside the delay window, the
// hook never reports `true`.
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setVisible(false);
      return;
    }
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setVisible(true);
    }, delayMs);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, delayMs]);

  return visible;
}
