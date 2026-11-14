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
  // The pid of its console's host. Absent for none.
  console: Schema.optionalKey(Schema.Int),
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
      const found = new Map<number, { startedAt: number; command: string }>();
      for (const pid of pids) {
        const row = table.get(pid);
        if (row !== undefined) {
          found.set(pid, { startedAt: row.birth, command: row.command ?? "" });
        }
      }
      return found;
    }, withSpawner);

    const identify = Effect.fn("ProcessTable.identify")(function* (
      pid: number,
    ) {
      const table = yield* readProcesses(helper).pipe(Effect.option);
      return Option.flatMap(table, (processes) =>
        Option.fromNullishOr(processes.get(pid)),
      );
    }, withSpawner);

    // Windows has no foreground, so a shell is held while a command it
    // started runs: its child, or another process on its console, where
    // what Git Bash forks and execs runs once its parent is gone. One it
    // left in the background holds it too. Untraced, as the terminals ask
    // every two seconds.
    const held = Effect.fnUntraced(function* (pids: ReadonlyArray<number>) {
      if (pids.length === 0) return new Set<number>();
      const shells = new Set(pids);
      const table = yield* readProcesses(helper);
      const onConsole = new Map<number, number>();
      for (const pid of shells) {
        const host = table.get(pid)?.console;
        if (host !== undefined) onConsole.set(host, pid);
      }
      const held = new Set<number>();
      for (const row of table.values()) {
        if (shells.has(row.parent)) held.add(row.parent);
        const shell =
          row.console === undefined ? undefined : onConsole.get(row.console);
        if (shell !== undefined && shell !== row.pid) held.add(shell);
      }
      return held;
    }, withSpawner);

    return { startedAt, listed, identify, held };
  });
