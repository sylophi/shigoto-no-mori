// Crash recovery for spawned scripts. `runningScripts` in ./index.ts is
// memory only, so the kill chains in main/index.ts cover a clean quit
// and nothing else: a force quit, a crash, or an OOM leaves every dev
// server running, reparented to launchd, still holding its port, with
// no UI left to stop it.
//
// So every spawn and every settle mirrors the live map into
// <root>/running-scripts.json, and the next boot sweeps whatever the
// previous session left behind. The file is disposable: a missing,
// stale, or unreadable one degrades to sweeping nothing. It never
// fails a boot, a spawn, or an exit.
//
// The dangerous half is the sweep. It works from a record that may be
// days old, and a pid that has been recycled belongs to a stranger by
// then, so isSameProcess below has to prove the pid is still ours
// before anything is signaled. Every inconclusive answer leaves the
// process alone.
import { execFile } from "node:child_process";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { OrphanScriptReport } from "@shared/schemas";
import { tempPathFor } from "../util/jsonFile";
import { withFileLock } from "../util/lockFile";
import { isENOENT, shigomoriRoot } from "../util/paths";
import { signalTree } from "./process";

const execFileP = promisify(execFile);

const FILE = "running-scripts.json";

// `ps` reports a start time to the second and we stamp startedAt just
// after spawn returns, so the two differ by that rounding plus spawn
// latency. Generous enough for a loaded machine, still orders of
// magnitude tighter than any plausible pid reuse.
const START_TOLERANCE_MS = 5_000;
// SIGTERM -> grace -> SIGKILL, same shape as killRecord in ./index.ts.
// Shorter than the interactive grace: this runs at boot, and a script
// that ignores SIGTERM shouldn't hold the sweep open.
const ORPHAN_GRACE_MS = 2_000;
const EXIT_POLL_MS = 100;

const PersistedScriptSchema = z.object({
  runId: z.string().min(1),
  // gte(2): the sweep signals the record's process *group* as -pid, and
  // kill(-1, ...) is "every process you may signal". No real child ever
  // has pid 1, but this file is untrusted input everywhere else, so the
  // one value that would broadcast a signal is refused at the schema.
  pid: z.number().int().gte(2),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1),
  startedAt: z.number().int().positive(),
  command: z.string(),
});

// ownerPid is the app instance that wrote the file. Two instances
// pointed at the same root (a dev build launched with SHIGOMORI_ROOT
// aimed at the packaged root) would otherwise have the second one's
// boot sweep kill the first one's live scripts out from under its
// window.
const SnapshotSchema = z.object({
  // Same floor as the script pids: pid 1 is launchd, which is always
  // alive, so an ownerPid of 1 would read as a live sibling instance
  // and permanently disable the boot sweep.
  ownerPid: z.number().int().gte(2),
  scripts: z.array(PersistedScriptSchema),
});

export type PersistedScript = z.infer<typeof PersistedScriptSchema>;
type Snapshot = z.infer<typeof SnapshotSchema>;

function filePath(): string {
  return join(shigomoriRoot(), FILE);
}

function lockPath(): string {
  return `${filePath()}.lock`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Replaces the file with our whole in-memory set. Sync and locked to
// match config/store.ts: the payload is a handful of records, and the
// settle path can run while the app is already tearing down, where a
// pending async write would never land.
export function persistRunningScripts(scripts: PersistedScript[]): void {
  const path = filePath();
  const snapshot: Snapshot = { ownerPid: process.pid, scripts };
  try {
    withFileLock(lockPath(), () => {
      const temp = tempPathFor(path);
      writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      try {
        renameSync(temp, path);
      } catch (error) {
        try {
          unlinkSync(temp);
        } catch {
          // Best effort. The stray tmp file is harmless.
        }
        throw error;
      }
    });
  } catch (error) {
    // Losing the record costs the next boot's sweep and nothing else.
    // A script run must not fail over it.
    console.warn(
      `[scripts] couldn't record running scripts: ${describe(error)}`,
    );
  }
}

// Lock-free like config/store.ts's reader: the rename above keeps the
// file itself always whole.
function readSnapshot(): Snapshot | null {
  let raw: string;
  try {
    raw = readFileSync(filePath(), "utf8");
  } catch (error) {
    // A missing file is the ordinary first-run case. Anything else is
    // worth saying out loud. Neither is evidence that nothing was
    // running, which is why both return null (nothing to sweep) rather
    // than an empty record set.
    if (!isENOENT(error)) {
      console.warn(`[scripts] couldn't read ${FILE}: ${describe(error)}`);
    }
    return null;
  }
  try {
    return SnapshotSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.warn(`[scripts] ignoring unusable ${FILE}: ${describe(error)}`);
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and simply isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LiveProcess {
  pid: number;
  pgid: number;
  startedAt: number;
  command: string;
}

// "  1234  1234 Mon Aug 17 18:42:41 2026 /bin/zsh -l -c pnpm dev"
const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/;

async function readProcessTable(
  pids: number[],
): Promise<Map<number, LiveProcess>> {
  const table = new Map<number, LiveProcess>();
  if (pids.length === 0) return table;
  let stdout: string;
  try {
    const result = await execFileP(
      "ps",
      // -ww so a long dev-server command line isn't truncated, LC_ALL
      // so lstart's month and day names stay parseable.
      ["-ww", "-p", pids.join(","), "-o", "pid=,pgid=,lstart=,command="],
      { env: { ...process.env, LC_ALL: "C" } },
    );
    stdout = result.stdout;
  } catch {
    // `ps` exits non-zero when none of the pids are live, which is the
    // ordinary "they all died with the app" case. A genuine failure to
    // run it lands here too and leaves the table empty, so nothing gets
    // signaled, which is the safe direction.
    return table;
  }
  for (const line of stdout.split("\n")) {
    const match = PS_LINE.exec(line);
    if (!match) continue;
    const startedAt = Date.parse(match[3]);
    if (Number.isNaN(startedAt)) continue;
    const pid = Number(match[1]);
    table.set(pid, {
      pid,
      pgid: Number(match[2]),
      startedAt,
      command: match[4].trim(),
    });
  }
  return table;
}

// The recorded command is what we handed the login shell, but a shell
// running a single simple command execs into it, so the live command
// line is often the program with its own argv: `pnpm dev` shows up as
// `node .../pnpm.cjs dev`, and a shell-quoted absolute path loses its
// quotes. Accept the whole recorded command, its leading word, or that
// word's basename, and treat anything else as inconclusive.
function commandMatches(recorded: string, live: string): boolean {
  const trimmed = recorded.trim();
  if (trimmed === "") return false;
  if (live.includes(trimmed)) return true;
  const head = (trimmed.split(/\s+/)[0] ?? "").replace(/['"]/g, "");
  if (head === "") return false;
  return live.includes(head) || live.includes(basename(head));
}

// The identity proof. A live pid says nothing on its own, so three
// independent facts have to agree before the sweep signals anything:
// the process leads its own group (spawnScript always detaches, and
// setsid survives an exec), it started when we recorded that it
// started, and its command line still looks like the one we launched.
function isSameProcess(
  record: PersistedScript,
  live: LiveProcess | undefined,
): boolean {
  if (!live) return false;
  if (live.pgid !== live.pid) return false;
  if (Math.abs(live.startedAt - record.startedAt) > START_TOLERANCE_MS) {
    return false;
  }
  return commandMatches(record.command, live.command);
}

// Polls instead of waiting on an exit event: these processes are not
// our children any more, so there is nothing to listen to.
function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const check = () => {
      if (!isProcessAlive(pid)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, EXIT_POLL_MS);
    };
    setTimeout(check, EXIT_POLL_MS);
  });
}

async function killOrphan(record: PersistedScript): Promise<boolean> {
  await signalTree(record.pid, "SIGTERM");
  if (await waitForExit(record.pid, ORPHAN_GRACE_MS)) return true;
  // Still alive after the grace period, or the number was freed and
  // taken over in the meantime. Re-prove the identity before escalating
  // so SIGKILL can't chase whatever inherited the pid.
  const table = await readProcessTable([record.pid]);
  if (!isSameProcess(record, table.get(record.pid))) return true;
  await signalTree(record.pid, "SIGKILL");
  const died = await waitForExit(record.pid, ORPHAN_GRACE_MS);
  if (!died) {
    console.warn(
      `[scripts] orphaned pid ${record.pid} survived SIGKILL, leaving it alone`,
    );
  }
  return died;
}

// Survivors get killed rather than adopted back into the UI. Their
// stdio pipes died with the main process that owned them, so there is
// no output left to stream and no console history to restore, and a
// row the user can only stop is worse than the invariant that what the
// UI shows is what is running. Killing also frees the ports the next
// run of the same script needs.
async function reapOrphans(
  records: PersistedScript[],
): Promise<OrphanScriptReport> {
  if (records.length === 0) return { stopped: 0 };
  const table = await readProcessTable(records.map((r) => r.pid));
  const ours = records.filter((r) => isSameProcess(r, table.get(r.pid)));
  if (ours.length === 0) return { stopped: 0 };
  const outcomes = await Promise.all(ours.map((r) => killOrphan(r)));
  const stopped = outcomes.filter(Boolean).length;
  console.warn(
    `[scripts] stopped ${stopped} of ${ours.length} script(s) left running by a previous session`,
  );
  return { stopped };
}

// Reads what the previous session left behind, then, unless another
// live instance owns it, immediately claims the file for this
// instance. Nothing can have spawned yet at boot, so the empty
// snapshot is accurate once claimed, and from here on every write is a
// full replace of our own state. The ownership check has to run before
// the claim, not after: writing first would overwrite a live sibling
// instance's record of its own running scripts before we've confirmed
// they aren't ours to touch.
function claimOrphanRecords(): PersistedScript[] {
  const previous = readSnapshot();
  if (
    previous &&
    previous.ownerPid !== process.pid &&
    isProcessAlive(previous.ownerPid)
  ) {
    // Another app instance is running those scripts right now, with a
    // window attached to them. Not ours to reap, and not ours to claim.
    return [];
  }
  persistRunningScripts([]);
  return previous?.scripts ?? [];
}

let sweep: Promise<OrphanScriptReport> | null = null;
let reported = false;

// Call once at boot, before any script can spawn. The claim is sync so
// the file is ours before the window opens. The `ps` probe and the kill
// escalation run in the background behind it.
export function startOrphanScriptSweep(): void {
  if (sweep) return;
  const records = claimOrphanRecords();
  sweep = reapOrphans(records).catch((error) => {
    console.warn(`[scripts] orphan sweep failed: ${describe(error)}`);
    return { stopped: 0 };
  });
}

// One-shot drain for the renderer's notice. Awaits the sweep rather
// than sampling it: the window regularly finishes loading before a
// survivor has finished dying, and a report that came back empty for
// that reason would drop the notice entirely.
export async function takeOrphanSweepReport(): Promise<OrphanScriptReport> {
  if (!sweep || reported) return { stopped: 0 };
  reported = true;
  return await sweep;
}
