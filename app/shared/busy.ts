// What a quit, a restart into an update or a data-folder move would
// interrupt, in words: the host counts it (host/lib/scripts,
// getBusyOperations) and the shell asks before going ahead
// (main/electron/busyPrompt.ts). Both sides word it from the counts.

export type BusyOperations = {
  readonly runningScripts: number;
  readonly inflightDeletes: number;
};

export type BusyAction = "quit" | "restart";

export const BUSY_COPY: Record<
  BusyAction,
  { message: string; proceed: string; gerund: string }
> = {
  quit: {
    message: "Stop running tasks and quit?",
    proceed: "Quit anyway",
    gerund: "Quitting",
  },
  restart: {
    message: "Stop running tasks and restart to update?",
    proceed: "Restart anyway",
    gerund: "Restarting",
  },
};

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

export function isBusy(busy: BusyOperations): boolean {
  return busy.runningScripts > 0 || busy.inflightDeletes > 0;
}

// The dialog's detail: what going ahead would do. Null when nothing is
// running and the action may proceed.
export function busyDetail(
  busy: BusyOperations,
  action: BusyAction,
): string | null {
  if (!isBusy(busy)) return null;
  const { gerund } = BUSY_COPY[action];
  // Lifecycle deletes spawn a teardown script that lands in
  // runningScripts, so prefer the script count to avoid double-counting
  // the same operation when both are non-zero.
  if (busy.runningScripts > 0) {
    const n = busy.runningScripts;
    const subject = pluralize(n, `${n} script is`, `${n} scripts are`);
    const obj = pluralize(n, "it", "them");
    return `${subject} still running. ${gerund} now will stop ${obj}.`;
  }
  const n = busy.inflightDeletes;
  const subject = pluralize(n, `${n} worktree is`, `${n} worktrees are`);
  return `${subject} being removed. ${gerund} now will interrupt cleanup and may leave files behind.`;
}

// The same verdict worded for ANOTHER device's screen, for an action a
// peer asked for: nobody here can answer a dialog, so it is refused
// with this. The dialog's detail would read as if the restart had
// happened once it crossed the wire; this says what was refused and
// what to do about it.
export function busyRemoteRefusal(
  busy: BusyOperations,
  action: BusyAction | "move",
): string | null {
  if (!isBusy(busy)) return null;
  const verb = {
    restart: "restarting to update",
    quit: "quitting",
    move: "moving the data folder",
  }[action];
  if (busy.runningScripts > 0) {
    const n = busy.runningScripts;
    return `${pluralize(n, `${n} script is`, `${n} scripts are`)} still running there. Stop ${pluralize(n, "it", "them")} before ${verb}.`;
  }
  const n = busy.inflightDeletes;
  return `${pluralize(n, `${n} worktree is`, `${n} worktrees are`)} still being removed there. Wait for that to finish before ${verb}.`;
}
