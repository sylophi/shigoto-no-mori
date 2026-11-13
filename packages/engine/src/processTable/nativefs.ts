// The process table as the nativefs helper reads it, on Windows, where
// no ps tells a process's parent, birth or command line. One call reads
// every process at one moment, and a parent born after its child is
// already left out (nativefs/processes_windows.go).
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { exec } from "../processes.ts";

const Process = Schema.Struct({
  pid: Schema.Int,
  // 0 once the process that started it is gone.
  parent: Schema.Int,
  // Epoch ms.
  birth: Schema.Int,
  name: Schema.String,
  // Only for the pids asked about, and only where it can be read.
  command: Schema.optionalKey(Schema.String),
});

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Process));

// Every process by its pid, `pids` with their command lines.
export const readProcesses = (
  helper: string,
  {
    pids = [],
    timeout,
  }: {
    readonly pids?: ReadonlyArray<number>;
    readonly timeout?: Duration.Input;
  } = {},
) =>
  exec(helper, ["processes", ...pids.map(String)], { timeout }).pipe(
    Effect.map(({ stdout }) => {
      const table = new Map<number, typeof Process.Type>();
      for (const line of stdout.split("\n")) {
        const row = decodeLine(line);
        if (Option.isSome(row)) table.set(row.value.pid, row.value);
      }
      return table;
    }),
  );

export const makeNativefs = (helper: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const withSpawner = Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      spawner,
    );

    // The stamp Windows took as it created the process, to the
    // millisecond here.
    const startedAt = Effect.fn("ProcessTable.startedAt")(function* (
      pid: number,
    ) {
      const table = yield* readProcesses(helper, {
        timeout: "5 seconds",
      }).pipe(Effect.option);
      return Option.flatMap(table, (processes) =>
        Option.fromNullishOr(processes.get(pid)?.birth),
      );
    }, withSpawner);

    // No process groups here, so nothing says whether one leads one.
    // A command line that can't be read matches no recorded one.
    const listed = Effect.fn("ProcessTable.listed")(function* (
      pids: ReadonlyArray<number>,
    ) {
      const table = yield* readProcesses(helper, {
        pids,
        timeout: "15 seconds",
      }).pipe(
        Effect.orElseSucceed(() => new Map<number, typeof Process.Type>()),
      );
      return new Map(
        pids.flatMap((pid) => {
          const found = table.get(pid);
          return found === undefined
            ? []
            : [
                [
                  pid,
                  { startedAt: found.birth, command: found.command ?? "" },
                ] as const,
              ];
        }),
      );
    }, withSpawner);

    const identify = Effect.fn("ProcessTable.identify")(function* (
      pid: number,
    ) {
      const table = yield* readProcesses(helper).pipe(Effect.option);
      return Option.flatMap(table, (processes) =>
        Option.map(
          Option.fromNullishOr(processes.get(pid)),
          ({ parent, name }) => ({ parent, name }),
        ),
      );
    }, withSpawner);

    // Windows has no foreground, so a shell is held while it has a
    // child: a command it runs, or one it left in the background.
    // Untraced, as the terminals ask every two seconds.
    const held = Effect.fnUntraced(function* (pids: ReadonlyArray<number>) {
      if (pids.length === 0) return new Set<number>();
      const shells = new Set(pids);
      const table = yield* readProcesses(helper);
      return new Set(
        [...table.values()]
          .map(({ parent }) => parent)
          .filter((parent) => shells.has(parent)),
      );
    }, withSpawner);

    return { startedAt, listed, identify, held };
  });
