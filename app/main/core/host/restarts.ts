// The shell's account of its host's unasked exits (hostProcess.ts):
// whether the host is started again or given up on, and which of the
// hosts gone the next is told to stop what they left
// (HostFacts.replacesHosts). Times are performance.now(): awake time,
// since neither a crash loop nor a reused pid happens during a sleep.

// A host that keeps dying is given up on, rather than forked in a loop.
export const CRASH_WINDOW_MS = 60_000;
const CRASHES_ALLOWED = 3;

type Spawned = { readonly pid: number; readonly startedAt: number };

export function restartLedger() {
  let crashes: number[] = [];
  let gone: (Spawned & { readonly exitedAt: number })[] = [];
  return {
    exited(
      spawned: Spawned | undefined,
      now: number,
    ):
      | { readonly kind: "restart" }
      | { readonly kind: "give-up"; readonly crashes: number } {
      crashes = [...crashes.filter((at) => at >= now - CRASH_WINDOW_MS), now];
      if (crashes.length > CRASHES_ALLOWED) {
        return { kind: "give-up", crashes: crashes.length };
      }
      // Only hosts that died within the crash window are vouched for: one
      // older may have left a group whose id is a stranger's by now.
      gone = gone.filter((host) => host.exitedAt >= now - CRASH_WINDOW_MS);
      if (spawned !== undefined) gone.push({ ...spawned, exitedAt: now });
      return { kind: "restart" };
    },
    // Up, its sweep has claimed what the hosts before it left.
    up(): void {
      gone = [];
    },
    // A host started again by hand (the migration page's Retry).
    retried(): void {
      crashes = [];
    },
    replacesHosts: (): Spawned[] =>
      gone.map(({ pid, startedAt }) => ({ pid, startedAt })),
  };
}
