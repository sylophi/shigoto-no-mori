// The process table as ps tells it, on a Mac and on Linux.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { exec } from "../processes.ts";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// ps's `lstart` ("Sat Oct 17 03:21:24 2026"), as ps prints it under
// PS_BIRTH_ENV, in epoch milliseconds, and none for anything else.
const parseLstart = (text: string): Option.Option<number> => {
  const match =
    /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
      text.trim(),
    );
  if (match === null) return Option.none();
  const [, month = "", day, hours, minutes, seconds, year] = match;
  const index = MONTHS.indexOf(month);
  if (index < 0) return Option.none();
  return Option.some(
    DateTime.toEpochMillis(
      DateTime.makeUnsafe({
        year: Number(year),
        month: index + 1,
        day: Number(day),
        hour: Number(hours),
        minute: Number(minutes),
        second: Number(seconds),
      }),
    ),
  );
};

// What `ps -o lstart` runs under: UTC, so a zone or a daylight-saving
// change doesn't move a birth, and C, so its names are English.
const PS_BIRTH_ENV = { TZ: "UTC", LC_ALL: "C" };

// "  1234  1234 Mon Aug 17 18:42:41 2026 /bin/zsh -l -c pnpm dev"
const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/;

type LiveProcess = {
  readonly startedAt: number;
  readonly command: string;
  readonly leadsGroup: boolean;
};

const parseProcessTable = (stdout: string) => {
  const table = new Map<number, LiveProcess>();
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (match === null) continue;
    const [, pid, pgid, lstart = "", command = ""] = match;
    const startedAt = parseLstart(lstart);
    if (Option.isNone(startedAt)) continue;
    table.set(Number(pid), {
      startedAt: startedAt.value,
      command: command.trim(),
      leadsGroup: Number(pgid) === Number(pid),
    });
  }
  return table;
};

export const makePs = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const withSpawner = Effect.provideService(
    ChildProcessSpawner.ChildProcessSpawner,
    spawner,
  );

  // The stamp the kernel took at its fork, which no later clock step
  // moves.
  const startedAt = Effect.fn("ProcessTable.startedAt")(function* (
    pid: number,
  ) {
    const ps = yield* exec("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: PS_BIRTH_ENV,
      extendEnv: true,
      timeout: "5 seconds",
    }).pipe(Effect.option);
    return Option.flatMap(ps, ({ stdout }) => parseLstart(stdout));
  }, withSpawner);

  const listed = Effect.fn("ProcessTable.listed")(function* (
    pids: ReadonlyArray<number>,
  ) {
    // -ww so a long dev-server command line isn't cut short.
    const ps = yield* exec(
      "ps",
      ["-p", pids.join(","), "-ww", "-o", "pid=,pgid=,lstart=,command="],
      { env: PS_BIRTH_ENV, extendEnv: true, timeout: "15 seconds" },
    ).pipe(Effect.option);
    // `ps` exits non-zero when none of the pids are live. A genuine
    // failure to run it lands here too, and both read as an empty table.
    return parseProcessTable(Option.isSome(ps) ? ps.value.stdout : "");
  }, withSpawner);

  const identify = Effect.fn("ProcessTable.identify")(function* (pid: number) {
    const ps = yield* exec("ps", ["-o", "ppid=,comm=", "-p", String(pid)]).pipe(
      Effect.option,
    );
    return Option.map(ps, ({ stdout }) => {
      const output = stdout.trim();
      const space = output.indexOf(" ");
      const ppid = space < 0 ? output : output.slice(0, space);
      const name = space < 0 ? "" : output.slice(space + 1);
      return { parent: Number(ppid), name };
    });
  }, withSpawner);

  // One is held while its terminal's foreground process group is not
  // its own. Untraced, as the terminals ask every two seconds.
  const held = Effect.fnUntraced(function* (pids: ReadonlyArray<number>) {
    if (pids.length === 0) return new Set<number>();
    const { stdout } = yield* exec("ps", [
      "-o",
      "pid=,tpgid=",
      "-p",
      pids.join(","),
    ]);
    return new Set(
      stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([pid, tpgid = 0]) => tpgid > 0 && tpgid !== pid)
        .map(([pid = 0]) => pid),
    );
  }, withSpawner);

  return { startedAt, listed, identify, held };
});
