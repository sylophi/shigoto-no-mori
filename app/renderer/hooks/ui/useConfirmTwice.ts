import { useEffect, useRef, useState } from "react";

// Two-step confirm sentinels. Lower for reversible-ish ops (removing a
// project from the list); higher for destructive ones (delete worktree,
// nuke shigomori state) so a stray double-click can't trigger them.
export const CONFIRM_QUICK_MS = 3_000;
export const CONFIRM_DESTRUCTIVE_MS = 5_000;

// Two-step confirm pattern: first click arms, second click within `timeoutMs`
// invokes the action. The armed flag auto-clears after the timeout, or
// when the caller invokes `reset` (e.g. when the host menu closes).
export function useConfirmTwice(timeoutMs = 2_500) {
  const keyed = useConfirmTwiceKeyed(timeoutMs);
  return {
    armed: keyed.armedKey !== null,
    trigger: (action: () => void) => keyed.trigger("", action),
    reset: keyed.reset,
  };
}

// The same two-step confirm over a list: one item at a time is armed,
// named by key. Arming another item moves the arm rather than adding a
// second, so a list can never hold two half-confirmed actions. The
// single-button form above is this with one key.
export function useConfirmTwiceKeyed(timeoutMs = 2_500) {
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const reset = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setArmedKey(null);
  };

  const trigger = (key: string, action: () => void) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (armedKey === key) {
      setArmedKey(null);
      action();
      return;
    }
    setArmedKey(key);
    timerRef.current = window.setTimeout(() => setArmedKey(null), timeoutMs);
  };

  return { armedKey, trigger, reset };
}
