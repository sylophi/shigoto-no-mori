// The machine's processes as testProcesses.mts reads them, and the
// signal to a process group: ps and kill(-pgid) where there are such,
// and on Windows, which has neither, the table the filesystem helper
// reads (nativefs/processes_windows.go). Windows has no process groups,
// so there each process is a group of its own, which its own signal
// reaches.
import { spawnSync } from "node:child_process";
import { nativefs } from "../packages/engine/test/lib/nativefs.ts";

export type Row = {
  ppid: number;
  pgid: number;
  zombie: boolean;
  // When it started: to the second from ps, to the millisecond on
  // Windows.
  start: number;
  // On Windows the image's name, and the command line only for the
  // pids a table was asked to name.
  command: string;
};

const windows = process.platform === "win32";

export const processTable: (named?: ReadonlyArray<number>) => Map<number, Row> =
  windows ? nativefsTable : psTable;

export function signalGroup(pgid: number, name: NodeJS.Signals): void {
  if (windows) return;
  try {
    process.kill(-pgid, name);
  } catch {
    // Gone already.
  }
}

// The lines `command` prints, and its pid: it lists itself, a child of
// this process.
function listed(command: string, args: string[], env?: NodeJS.ProcessEnv) {
  const run = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  if (run.error !== undefined) {
    throw new Error(`${command} didn't run: ${run.error.message}`);
  }
  return { lines: run.stdout.split("\n"), self: run.pid };
}

function psTable(): Map<number, Row> {
  const { lines, self } = listed(
    "/bin/ps",
    ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="],
    // lstart in a form Date.parse reads, whatever the locale.
    { ...process.env, LC_ALL: "C", TZ: "UTC" },
  );
  const rows = new Map<number, Row>();
  for (const line of lines) {
    const [pid, ppid, pgid, stat, ...rest] = line.trim().split(/\s+/);
    if (stat === undefined || Number(pid) === self) continue;
    rows.set(Number(pid), {
      ppid: Number(ppid),
      pgid: Number(pgid),
      zombie: stat.startsWith("Z"),
      start: Date.parse(`${rest.slice(0, 5).join(" ")} UTC`),
      command: rest.slice(5).join(" "),
    });
  }
  return rows;
}

type Listed = {
  pid: number;
  // 0 once the process that started it is gone.
  parent: number;
  birth: number;
  name: string;
  command?: string;
};

function nativefsTable(named: ReadonlyArray<number> = []): Map<number, Row> {
  const { lines, self } = listed(nativefs(), [
    "processes",
    ...named.map(String),
  ]);
  const rows = new Map<number, Row>();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const { pid, parent, birth, name, command } = JSON.parse(line) as Listed;
    if (pid === self) continue;
    rows.set(pid, {
      ppid: parent,
      pgid: pid,
      zombie: false,
      start: birth,
      command: command ?? name,
    });
  }
  return rows;
}
