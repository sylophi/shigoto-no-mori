// The one owner of what a proof or a lab run starts: it ends
// with them, however they end. A case that fails or runs out of time, a
// lab run that throws, Ctrl-C, a kill or the terminal closing end every
// process this one started and everything under it, the processes that
// left its group included (`sm` runs git in a session of its own, as
// the engine runs every command). What a proof spawns itself it hands
// to `own`, which ends it with the case it started in
// (testProcesses.setup.mts); what the code under test starts ends with
// the file, and everything with the run.
//
// `onRunEnd(end)` runs `end` once, synchronously, on exit or on SIGINT,
// SIGTERM or SIGHUP, which would otherwise end the process with no
// teardown at all; then everything the process started is ended
// (`endAll`), and the signal ends the process as it would have. vitest
// SIGTERMs its forks at the end of a run (SIGKILL 500 ms later), and
// the terminal's Ctrl-C reaches them, so a fork ends its own there.
import { type ChildProcess, spawnSync } from "node:child_process";

const ends = new Set<() => void>();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let listening = false;

function runEnds(): void {
  for (const end of ends) {
    ends.delete(end);
    try {
      end();
    } catch {
      // The rest still run.
    }
  }
  try {
    endAll();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
  }
}

function onSignal(name: NodeJS.Signals): void {
  runEnds();
  for (const each of SIGNALS) process.off(each, onSignal);
  process.kill(process.pid, name);
}

// From here on, the run's end ends everything the process started.
export function endsWithRun(): void {
  if (listening) return;
  listening = true;
  process.once("exit", runEnds);
  for (const each of SIGNALS) process.on(each, onSignal);
}

// The function returned forgets `end`, for a teardown that did the work
// itself.
export function onRunEnd(end: () => void): () => void {
  endsWithRun();
  ends.add(end);
  return () => {
    ends.delete(end);
  };
}

// The pid `text` holds (a pid file, a line of output), or undefined
// while it holds none: a file `echo $! >` writes is empty until echo has
// written, and Number("") is 0, which process.kill takes for this
// process's own group.
export function pidIn(text: string): number | undefined {
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

// A signal to `pid` that may have gone already.
export function signalIfAlive(pid: number, name: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

// Owned pids, by the scope they end with (a vitest case's, or the
// file's or the lab run's when no case is running), each with when it
// was owned.
const runScope = new Map<number, number>();
let scope = runScope;

// `child`, or a process that is no child of ours (an app opened through
// LaunchServices, a stray that left its parent), ends with the current
// scope, and at the latest with the run.
export function own<T extends ChildProcess | number>(child: T): T {
  const pid = typeof child === "number" ? child : child.pid;
  if (pid === undefined) return child;
  endsWithRun();
  const at = Date.now();
  scope.set(pid, at);
  runScope.set(pid, at);
  return child;
}

// A vitest case's scope opens: what it owns until the function returned
// ends it.
export function caseScope(): () => void {
  const mine = new Map<number, number>();
  scope = mine;
  return () => {
    scope = runScope;
    for (const pid of mine.keys()) runScope.delete(pid);
    endTrees(mine);
  };
}

// Everything this process started that still runs (the code under
// test's children too, a host's git or a script it ran) and everything
// it owns, ended and checked gone.
export function endAll(): void {
  const roots = new Map([[process.pid, Date.now()], ...runScope]);
  runScope.clear();
  endTrees(roots);
}

const GRACE_MS = 250;
const KILLED_WITHIN_MS = 2_000;
const POLL_MS = 50;

type Row = {
  ppid: number;
  pgid: number;
  zombie: boolean;
  // When it started, to the second.
  start: number;
  command: string;
};

function processTable(): Map<number, Row> {
  const listed = spawnSync(
    "/bin/ps",
    ["-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // lstart in a form Date.parse reads, whatever the locale.
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    },
  );
  if (listed.error !== undefined) {
    throw new Error(`ps didn't run: ${listed.error.message}`);
  }
  const rows = new Map<number, Row>();
  for (const line of listed.stdout.split("\n")) {
    const [pid, ppid, pgid, stat, ...rest] = line.trim().split(/\s+/);
    // ps lists itself, a child of this process.
    if (stat === undefined || Number(pid) === listed.pid) continue;
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

// This process and its ancestors (vitest, pnpm, lefthook, a `git commit`,
// the terminal's job), and their groups: never signalled. A child
// spawned without `detached` shares this process's group, which is
// theirs.
function keptOf(rows: Map<number, Row>) {
  const pids = new Set<number>();
  const groups = new Set<number>();
  for (let pid = process.pid; pid > 1 && !pids.has(pid);) {
    const row = rows.get(pid);
    if (row === undefined) break;
    pids.add(pid);
    groups.add(row.pgid);
    pid = row.ppid;
  }
  return { pids, groups };
}

// Grows `ours` (pid to start) to every process below one of them or in
// one of their groups, never one that is kept, and answers those groups
// as listed now: never a kept one, nor one led by a process not ours. A
// pid listed with another start than ours had is another process.
function grow(
  ours: Map<number, number>,
  rows: Map<number, Row>,
  kept: ReturnType<typeof keptOf>,
): Set<number> {
  const isOurs = (pid: number) => {
    const start = rows.get(pid)?.start;
    return start !== undefined && ours.get(pid) === start;
  };
  const groups = new Set<number>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, { pgid }] of rows) {
      if (isOurs(pid) && !kept.groups.has(pgid)) {
        if (!rows.has(pgid) || isOurs(pgid)) groups.add(pgid);
      }
    }
    for (const [pid, row] of rows) {
      if (ours.has(pid) || kept.pids.has(pid)) continue;
      if (isOurs(row.ppid) || groups.has(row.pgid)) {
        ours.set(pid, row.start);
        grew = true;
      }
    }
  }
  return groups;
}

const sleepSync = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Ends each root (a pid, with when it was owned) and everything under it
// (this process: only what is under it): SIGTERM, a short grace, then
// SIGKILL, and throws naming whatever is still running after that. A
// root that started after it was owned took the pid once ours had gone,
// and is left alone.
// Synchronous, so it can run from an exit or a signal. The whole tree is
// found before any of it is signalled: once `sm` is gone, the git it
// started in a session of its own has no parent to be found by.
function endTrees(roots: ReadonlyMap<number, number>): void {
  if (roots.size === 0) return;
  let rows = processTable();
  const kept = keptOf(rows);
  const ours = new Map<number, number>();
  for (const [pid, ownedAt] of roots) {
    const start = rows.get(pid)?.start;
    if (pid > 1 && start !== undefined && start <= ownedAt) {
      ours.set(pid, start);
    }
  }
  let groups = new Set<number>();
  const alive = () => {
    groups = grow(ours, rows, kept);
    return [...ours].flatMap(([pid, start]) => {
      const row = rows.get(pid);
      return !kept.pids.has(pid) && row?.start === start && !row.zombie
        ? [pid]
        : [];
    });
  };
  const signal = (name: NodeJS.Signals) => {
    const pids = alive();
    for (const group of groups) signalIfAlive(-group, name);
    for (const pid of pids) signalIfAlive(pid, name);
  };
  const waitGone = (ms: number) => {
    const deadline = Date.now() + ms;
    while (alive().length > 0 && Date.now() < deadline) {
      sleepSync(POLL_MS);
      rows = processTable();
    }
  };
  if (alive().length === 0) return;
  signal("SIGTERM");
  waitGone(GRACE_MS);
  if (alive().length > 0) signal("SIGKILL");
  waitGone(KILLED_WITHIN_MS);
  const left = alive();
  if (left.length > 0) {
    const named = left.map((pid) => `${pid} ${rows.get(pid)?.command}`);
    throw new Error(`still running after SIGKILL: ${named.join("; ")}`);
  }
}

// For a proof's synchronous spawn (execFileSync, spawnSync), which blocks
// the process: no deadline of the case's or vitest's can fire while it
// waits, so a stuck one is killed here instead.
export const SYNC_SPAWN = { timeout: 60_000, killSignal: "SIGKILL" } as const;
