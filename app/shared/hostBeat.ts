// The beat a host posts its shell every few seconds (host/process/
// host.ts): a loop that stops beating is stuck, and the spans it had
// open at its last beat are what main.log names when the shell starts
// it again (main/hostProcess.ts).
import type * as Tracer from "effect/Tracer";

export type HostBeat = {
  // The newest first, then the oldest, with how long each had run.
  readonly open: ReadonlyArray<{ readonly name: string; readonly ms: number }>;
};

const NAMED = 5;

// Every span in `open` has started and not ended (shared/observability.ts).
export function beatOf(open: Iterable<Tracer.Span>, now: number): HostBeat {
  const started: Array<{ name: string; ms: number }> = [];
  for (const span of open) {
    // A call's span on the links ("DeviceLink.worktrees:watchChanges"),
    // which a view holds open for as long as a window reads it: the
    // service spans under a stuck call name it better.
    if (span.name.includes(":")) continue;
    started.push({
      name: span.name,
      ms: now - Number(span.status.startTime / 1_000_000n),
    });
  }
  started.sort((a, b) => a.ms - b.ms);
  // The newest, and the oldest: a call stuck since before the newest
  // began.
  const oldest = started.length > NAMED ? started.slice(-1) : [];
  return { open: [...started.slice(0, NAMED - oldest.length), ...oldest] };
}

export const isHostBeat = (message: unknown): message is HostBeat =>
  typeof message === "object" &&
  message !== null &&
  Array.isArray((message as { open?: unknown }).open);
