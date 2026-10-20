// The terminal's output from a process of its own, under Bun as the
// binary runs it: `count` documents of 64 KiB through emit, each counted
// on stderr once its write is done, unless `quiet` is passed, and with
// the scheduler yielding every `budget` operations when one is given.
// The tests hold or close its reader (output.test.ts).
//
//   bun test/fixtures/flood.ts <count> [quiet] [budget=<n>]
import * as Effect from "effect/Effect";
import * as Scheduler from "effect/Scheduler";
import { emit, watchStreams } from "../../src/output.ts";

watchStreams();
const count = Number(process.argv[2] ?? "0");
const flags = process.argv.slice(3);
const quiet = flags.includes("quiet");
const budget = flags.find((flag) => flag.startsWith("budget="));
const pad = "x".repeat(64 * 1024);

await Effect.runPromise(
  Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) =>
      emit({ i, pad }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (!quiet) process.stderr.write(`${i + 1}\n`);
          }),
        ),
      ),
    { discard: true },
  ).pipe(
    budget === undefined
      ? (effect) => effect
      : Effect.provideService(
          Scheduler.MaxOpsBeforeYield,
          Number(budget.slice("budget=".length)),
        ),
  ),
);
