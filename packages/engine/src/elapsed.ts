// Elapsed time for in-process budgets, uptimes and freshness gates:
// the Clock's monotonic reading in milliseconds, which no step of the
// wall clock moves. On macOS it also stands still while the machine
// sleeps. Epoch time (Clock.currentTimeMillis) stays for dates that are
// shown, stored or compared with another machine.
import type * as Clock from "effect/Clock";

const NANOS_PER_MILLI = 1_000_000n;

export const elapsedMillisUnsafe = (clock: Clock.Clock): number =>
  Number(clock.monotonicTimeNanosUnsafe() / NANOS_PER_MILLI);
