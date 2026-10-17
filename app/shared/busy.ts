// What a quit, a restart into an update or a data-folder move would
// interrupt, in words: the host counts it (host/lib/Scripts.ts, busy)
// and the shell asks before going ahead (main/electron/busyPrompt.ts).
// Both sides word it from the counts.

export type BusyOperations = {
  // PTY runs and the engine's lifecycle runs alike.
  readonly runningScripts: number;
  // Worktree deletes and moves, and project removals.
  readonly inflightDeletes: number;
  // Any other change the engine is making.
  readonly engineChanges: number;
  // Terminals whose shell runs something.
  readonly busyTerminals: number;
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
    busy.busyTerminals > 0 ||
    busy.inflightDeletes > 0 ||
    busy.engineChanges > 0
  );
}

// What is running, scripts and terminals both: "2 scripts and 1
// terminal are", and the pronoun for them. Null with neither.
function runningWords(
  busy: BusyOperations,
): { subject: string; obj: string } | null {
  const parts = [
    [busy.runningScripts, "script", "scripts"],
    [busy.busyTerminals, "terminal", "terminals"],
  ] as const;
  const named = parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${pluralize(n, one, many)}`);
  if (named.length === 0) return null;
  const total = busy.runningScripts + busy.busyTerminals;
  return {
    subject: `${named.join(" and ")} ${pluralize(total, "is", "are")}`,
    obj: pluralize(total, "it", "them"),
  };
}

// "1 change is", and the pronoun for it.
function changeWords(busy: BusyOperations): { subject: string; obj: string } {
  const n = busy.engineChanges;
  return {
    subject: pluralize(n, `${n} change is`, `${n} changes are`),
    obj: pluralize(n, "it", "them"),
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
  const running = runningWords(busy);
  if (running !== null) {
    return `${running.subject} still running. ${gerund} now will stop ${running.obj}.`;
  }
  const n = busy.inflightDeletes;
  if (n > 0) {
    const subject = pluralize(n, `${n} worktree is`, `${n} worktrees are`);
    return `${subject} being removed. ${gerund} now will interrupt cleanup and may leave files behind.`;
  }
  const changes = changeWords(busy);
  return `${changes.subject} still being made. ${gerund} now will interrupt ${changes.obj}.`;
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
  if (n > 0) {
    return `${pluralize(n, `${n} worktree is`, `${n} worktrees are`)} still being removed there. Wait for that to finish before ${verb}.`;
  }
  const changes = changeWords(busy);
  return `${changes.subject} still being made there. Wait for ${changes.obj} to finish before ${verb}.`;
}
