// What the engine and the host read of other processes on this machine:
// when one was born, what it runs and what holds a shell. Each OS reads
// its own table (processTable/), and what it means is shared here.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { byPlatform } from "./platform.ts";
import { type CommandError, pidAlive } from "./processes.ts";
import { makeNativefs } from "./processTable/nativefs.ts";
import { makePs } from "./processTable/ps.ts";

// A record's birth when the process that wrote it couldn't read its own.
export const UNKNOWN_BIRTH = 0;

// How far a birth the table reports may be from a recorded one of the
// same process: ps counts in whole seconds, and a spawn is stamped just
// after it returns. Generous enough for a loaded machine, still orders
// of magnitude tighter than any plausible pid reuse.
export const BIRTH_TOLERANCE_MS = 5_000;

export type LiveProcess = {
  // Epoch ms, to the second or finer.
  readonly startedAt: number;
  readonly command: string;
  // Whether it leads its process group, where the OS has groups.
  readonly leadsGroup?: boolean;
};

export class ProcessTable extends Context.Service<
  ProcessTable,
  {
    // When `pid` was born, in epoch milliseconds to the second or
    // finer. None when it can't be read.
    readonly startedAt: (pid: number) => Effect.Effect<Option.Option<number>>;
    // Whether the process that recorded itself as `pid`, born at
    // `startedAt`, still runs.
    readonly stillRunning: (
      pid: number,
      startedAt: number,
    ) => Effect.Effect<boolean>;
    // The live processes among `pids`. Empty when none lives or the
    // table can't be read.
    readonly listed: (
      pids: ReadonlyArray<number>,
    ) => Effect.Effect<ReadonlyMap<number, LiveProcess>>;
    // A process's parent and its program's name. None when it is gone
    // or can't be read.
    readonly identify: (pid: number) => Effect.Effect<
      Option.Option<{
        readonly parent: number;
        readonly name: string;
      }>
    >;
    // The shells among `pids` that a command they started holds in the
    // foreground.
    readonly held: (
      pids: ReadonlyArray<number>,
    ) => Effect.Effect<ReadonlySet<number>, CommandError>;
  }
>()("sm/engine/ProcessTable") {}

// `nativefs` is the helper that reads the table on Windows.
const make = (nativefs: string) =>
  Effect.gen(function* () {
    const table = yield* byPlatform({
      darwin: makePs,
      linux: makePs,
      win32: makeNativefs(nativefs),
    });

    // A live pid born at another time is another process the system
    // handed the number to since. A birth unknown on either side counts as
    // the same process, so nothing takes over the work of an owner it
    // can't tell is gone.
    const stillRunning = Effect.fn("ProcessTable.stillRunning")(function* (
      pid: number,
      startedAt: number,
    ) {
      if (pid < 2 || !(yield* pidAlive(pid))) return false;
      if (startedAt === UNKNOWN_BIRTH) return true;
      const started = yield* table.startedAt(pid);
      return (
        Option.isNone(started) ||
        Math.abs(started.value - startedAt) <= BIRTH_TOLERANCE_MS
      );
    });

    return ProcessTable.of({ ...table, stillRunning });
  });

export const layer = (nativefs: string) =>
  Layer.effect(ProcessTable, make(nativefs));
