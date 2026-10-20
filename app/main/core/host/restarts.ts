// The shell's account of its host's unasked exits (hostProcess.ts):
// whether the host is started again or given up on. Times are
// performance.now(): awake time, since a crash loop doesn't happen
// during a sleep.

// A host that keeps dying is given up on, rather than forked in a loop.
export const CRASH_WINDOW_MS = 60_000;
const CRASHES_ALLOWED = 3;

export function restartLedger() {
  let crashes: number[] = [];
  return {
    exited(
      now: number,
    ):
      | { readonly kind: "restart" }
      | { readonly kind: "give-up"; readonly crashes: number } {
      crashes = [...crashes.filter((at) => at >= now - CRASH_WINDOW_MS), now];
      if (crashes.length > CRASHES_ALLOWED) {
        return { kind: "give-up", crashes: crashes.length };
      }
      return { kind: "restart" };
    },
    // A host started again by hand (the migration page's Retry).
    retried(): void {
      crashes = [];
    },
  };
}
