import { useEffect, useRef, useState } from "react";

// Two-step confirm pattern: first click arms, second click within `timeoutMs`
// invokes the action. The armed flag auto-clears after the timeout.
export function useConfirmTwice(timeoutMs = 2_500) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const trigger = (action: () => void) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (armed) {
      setArmed(false);
      action();
      return;
    }
    setArmed(true);
    timerRef.current = window.setTimeout(() => setArmed(false), timeoutMs);
  };

  return { armed, trigger };
}
