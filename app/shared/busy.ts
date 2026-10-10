// What a quit, a restart into an update or a data-folder move would
// interrupt, in words: the host counts it (host/lib/scripts,
// getBusyOperations) and the shell asks before going ahead
// (main/electron/busyPrompt.ts). Both sides word it from the counts.

export type BusyOperations = {
  readonly runningScripts: number;
  readonly inflightDeletes: number;
  // Terminals whose shell runs something, for a quit or a restart.
  readonly busyTerminals?: number;
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

function isBusy(busy: BusyOperations): boolean {
  return (
    busy.runningScripts > 0 ||
    (busy.busyTerminals ?? 0) > 0 ||
    busy.inflightDeletes > 0
  );
}

// What is running, scripts and terminals both: "2 scripts and 1
// terminal are", and the pronoun for them. Null with neither.
function runningWords(
  busy: BusyOperations,
): { subject: string; obj: string } | null {
  const parts = [
    [busy.runningScripts, "script", "scripts"],
    [busy.busyTerminals ?? 0, "terminal", "terminals"],
  ] as const;
  const named = parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${pluralize(n, one, many)}`);
  if (named.length === 0) return null;
  const total = busy.runningScripts + (busy.busyTerminals ?? 0);
  return {
    subject: `${named.join(" and ")} ${pluralize(total, "is", "are")}`,
    obj: pluralize(total, "it", "them"),
  };
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
  const running = runningWords(busy);
  if (running !== null) {
    return `${running.subject} still running. ${gerund} now will stop ${running.obj}.`;
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
  const running = runningWords(busy);
  if (running !== null) {
    return `${running.subject} still running there. Stop ${running.obj} before ${verb}.`;
  }
  const n = busy.inflightDeletes;
  return `${pluralize(n, `${n} worktree is`, `${n} worktrees are`)} still being removed there. Wait for that to finish before ${verb}.`;
}
