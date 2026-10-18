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
  // The arm the second click is checked against. The timer only draws
  // the arm away: a hidden window's timers run late, and a sleep stops
  // them, so a click after the deadline must not find it still set.
  // Both clocks have to say it is in time, so neither a sleep (the
  // monotonic one stands still) nor a clock step (the wall one jumps)
  // stretches it.
  const armRef = useRef<(ConfirmArm & { key: string }) | null>(null);

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
    armRef.current = null;
    setArmedKey(null);
  };

  const trigger = (key: string, action: () => void) => {
    const arm = armRef.current;
    if (arm?.key === key && confirmInTime(arm, timeoutMs, clocks())) {
      reset();
      action();
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    armRef.current = { key, ...clocks() };
    setArmedKey(key);
    timerRef.current = window.setTimeout(reset, timeoutMs);
  };

  return { armedKey, trigger, reset };
}

interface ConfirmArm {
  readonly monotonic: number;
  readonly wall: number;
}

const clocks = (): ConfirmArm => ({
  monotonic: performance.now(),
  wall: Date.now(),
});

export function confirmInTime(
  arm: ConfirmArm,
  timeoutMs: number,
  now: ConfirmArm,
): boolean {
  const wall = now.wall - arm.wall;
  return (
    now.monotonic - arm.monotonic < timeoutMs && wall >= 0 && wall < timeoutMs
  );
}
