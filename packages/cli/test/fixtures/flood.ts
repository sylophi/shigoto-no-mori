// The terminal's output from a process of its own, under Bun as the
// binary runs it: `count` documents of 64 KiB through emit, each counted
// on stderr once its write is done, unless `quiet` is passed, and with
// the scheduler yielding every `budget` operations when one is given.
// With `child`, it first starts a `sleep` as a command starts git, its
// pid on stderr, and waits on it after the writes, the whole run as
// main.ts runs a command, ended once stdout's reader goes. The tests hold or close its reader
// (output.test.ts).
//
//   bun test/fixtures/flood.ts <count> [quiet] [budget=<n>] [child]
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Scheduler from "effect/Scheduler";
import { emit, untilReaderGone, watchStreams } from "../../src/output.ts";

watchStreams();
const count = Number(process.argv[2] ?? "0");
const flags = process.argv.slice(3);
const quiet = flags.includes("quiet");
const budget = flags.find((flag) => flag.startsWith("budget="));
const pad = "x".repeat(64 * 1024);

const writes = Effect.forEach(
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
);

// A command that waits on its git: it ends only by being ended.
const withChild = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sleep = yield* spawner.spawn(
    ChildProcess.make("sleep", ["600"], { stdin: "ignore" }),
  );
  process.stderr.write(`child ${sleep.pid}\n`);
  yield* writes;
  yield* sleep.exitCode;
});

await Effect.runPromise(
  flags.includes("child")
    ? Effect.scoped(withChild).pipe(
        untilReaderGone,
        Effect.provide(BunServices.layer),
      )
    : writes,
);
