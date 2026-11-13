// The machine's processes as testProcesses.mts reads them, and the
// signal to a process group: ps and kill(-pgid) where there are such,
// and on Windows, which has neither, CIM's list read through the
// PowerShell every Windows has. Windows has no process groups, so there
// each process is a group of its own, which its own signal reaches.
import { spawnSync } from "node:child_process";

export type Row = {
  ppid: number;
  pgid: number;
  zombie: boolean;
  // When it started: to the second from ps, to the millisecond from CIM.
  start: number;
  command: string;
};

const windows = process.platform === "win32";

export const processTable = windows ? cimTable : psTable;

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

const CIM = [
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  // A command line can span lines, so its whitespace is flattened: one
  // process, one line.
  `Get-CimInstance Win32_Process | Where-Object CreationDate | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $(([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()) $($_.CommandLine -replace '\\s+', ' ')" }`,
].join("; ");

function cimTable(): Map<number, Row> {
  const { lines, self } = listed("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    CIM,
  ]);
  const rows = new Map<number, Row>();
  for (const line of lines) {
    const [pid, ppid, start, ...command] = line.trim().split(/\s+/);
    if (start === undefined || Number(pid) === self) continue;
    rows.set(Number(pid), {
      ppid: Number(ppid),
      pgid: Number(pid),
      zombie: false,
      start: Number(start),
      command: command.join(" "),
    });
  }
  // A process whose parent has gone still names the parent's pid, which
  // another may have taken since: a child starts no sooner than its
  // parent.
  for (const row of rows.values()) {
    if ((rows.get(row.ppid)?.start ?? 0) > row.start) row.ppid = 0;
  }
  return rows;
}
