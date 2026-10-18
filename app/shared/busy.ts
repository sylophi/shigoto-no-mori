// What a quit, a restart into an update or a data-folder move would
// interrupt, in words: the host counts it (host/lib/Scripts.ts, busy)
// and the shell asks before going ahead (main/electron/busyPrompt.ts).
// Both sides word it from the counts.
import { listed, plural, pluralize } from "@shigomori/contracts/words";
import type { ChangeKind } from "@shigomori/contracts/modules/session";

export type BusyOperations = {
  // PTY runs and the engine's lifecycle runs alike.
  readonly runningScripts: number;
  // Worktree deletes, and project removals.
  readonly inflightDeletes: number;
  // Worktree moves and renames, the data-folder move's included.
  readonly inflightMoves: number;
  // The other git work a person started (or an auto-pull's), one
  // entry each.
  readonly engineChanges: ReadonlyArray<ChangeKind>;
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

function isBusy(busy: BusyOperations): boolean {
  return (
    busy.runningScripts > 0 ||
    busy.busyTerminals > 0 ||
    busy.inflightDeletes > 0 ||
    busy.inflightMoves > 0 ||
    busy.engineChanges.length > 0
  );
}

// What is running, scripts and terminals both: "2 scripts and 1
// terminal are", and the pronoun for them. Null with neither.
function runningWords(
  busy: BusyOperations,
): { subject: string; obj: string } | null {
  const parts = [
    [busy.runningScripts, "script"],
    [busy.busyTerminals, "terminal"],
  ] as const;
  const named = parts
    .filter(([n]) => n > 0)
    .map(([n, noun]) => pluralize(n, noun));
  if (named.length === 0) return null;
  const total = busy.runningScripts + busy.busyTerminals;
  return {
    subject: `${listed(named)} ${plural(total, "is", "are")}`,
    obj: plural(total, "it", "them"),
  };
}

// What each kind of change is, as one and as several, and what it is
// still doing, in the order a sentence names them. The worktrees a
// removal or a move marks share the removal's and the move's words.
const CHANGE_WORDS: ReadonlyArray<{
  readonly kind: ChangeKind;
  readonly one: string;
  readonly many: string;
  readonly doing: string;
  // What it is doing in words for another device's screen, where it
  // differs.
  readonly doingThere?: string;
  readonly git: boolean;
}> = [
  {
    kind: "remove",
    one: "a worktree",
    many: "worktrees",
    doing: "being removed",
    git: false,
  },
  {
    kind: "move",
    one: "a worktree",
    many: "worktrees",
    doing: "being moved",
    git: false,
  },
  {
    kind: "pull",
    one: "a pull",
    many: "pulls",
    doing: "being made",
    git: true,
  },
  {
    kind: "push",
    one: "a push",
    many: "pushes",
    doing: "being made",
    git: true,
  },
  {
    kind: "fetch",
    one: "a fetch",
    many: "fetches",
    doing: "being made",
    git: true,
  },
  {
    kind: "commit",
    one: "a commit",
    many: "commits",
    doing: "being made",
    git: true,
  },
  {
    kind: "merge",
    one: "a merge",
    many: "merges",
    doing: "being made",
    git: true,
  },
  {
    kind: "checkout",
    one: "a checkout",
    many: "checkouts",
    doing: "being made",
    git: true,
  },
  {
    kind: "stash",
    one: "a stash",
    many: "stashes",
    doing: "being made",
    git: true,
  },
  {
    kind: "autoPull",
    one: "an auto-pull",
    many: "auto-pulls",
    doing: "being made",
    git: true,
  },
  {
    kind: "create",
    one: "a new worktree",
    many: "new worktrees",
    doing: "being made",
    git: false,
  },
  {
    kind: "unstash",
    one: "a stash",
    many: "stashes",
    doing: "being applied",
    git: true,
  },
  {
    kind: "finish",
    one: "a branch",
    many: "branches",
    doing: "being finished",
    git: true,
  },
  {
    kind: "pullRequest",
    one: "a pull request",
    many: "pull requests",
    doing: "being opened",
    git: false,
  },
  {
    kind: "send",
    one: "a worktree",
    many: "worktrees",
    doing: "being sent",
    doingThere: "being sent off",
    git: false,
  },
  {
    kind: "bring",
    one: "a worktree",
    many: "worktrees",
    doing: "being brought here",
    doingThere: "being brought in",
    git: false,
  },
  {
    kind: "land",
    one: "a worktree",
    many: "worktrees",
    doing: "arriving",
    git: false,
  },
];

const capitalized = (words: string) =>
  words.charAt(0).toUpperCase() + words.slice(1);

// Everything under way as one clause each, the ones doing the same
// thing as one ("2 pulls and a push are still being made", "3
// operations (…) are still being made" past two), worded for this
// device's screen or another's (`there`), how many there are, and
// whether any is a running script or terminal, a removal, or something
// else. A pull and push is a pull and a push.
function underWay(busy: BusyOperations, there = false) {
  const changes = busy.engineChanges.flatMap((kind): ChangeKind[] =>
    kind === "pullAndPush" ? ["pull", "push"] : [kind],
  );
  const clauses: string[] = [];
  const running = runningWords(busy);
  if (running !== null) clauses.push(`${running.subject} still running`);
  const marked: Partial<Record<ChangeKind, number>> = {
    remove: busy.inflightDeletes,
    move: busy.inflightMoves,
  };
  const groups = new Map<
    string,
    { parts: string[]; n: number; git: boolean }
  >();
  for (const words of CHANGE_WORDS) {
    const n =
      (marked[words.kind] ?? 0) +
      changes.filter((kind) => kind === words.kind).length;
    if (n === 0) continue;
    const doing = (there ? words.doingThere : undefined) ?? words.doing;
    const group = groups.get(doing) ?? { parts: [], n: 0, git: true };
    group.parts.push(n === 1 ? words.one : `${n} ${words.many}`);
    group.n += n;
    group.git &&= words.git;
    groups.set(doing, group);
  }
  for (const [doing, { parts, n, git }] of groups) {
    clauses.push(
      parts.length > 2
        ? `${n} ${git ? "git operations" : "operations"} (${listed(parts)}) are still ${doing}`
        : `${listed(parts)} ${plural(n, "is", "are")} still ${doing}`,
    );
  }
  const total =
    busy.runningScripts +
    busy.busyTerminals +
    [...groups.values()].reduce((sum, group) => sum + group.n, 0);
  const removing = groups.has("being removed");
  return {
    clauses,
    obj: plural(total, "it", "them"),
    runningOnly: running !== null && groups.size === 0,
    removingOnly: removing && running === null && groups.size === 1,
    removing,
    others: groups.size > 0,
    running: running !== null,
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
  const what = underWay(busy);
  const then = what.runningOnly
    ? `stop ${what.obj}`
    : what.removingOnly
      ? "interrupt cleanup and may leave files behind"
      : `interrupt ${what.obj}${what.removing ? " and may leave files behind" : ""}`;
  return `${capitalized(listed(what.clauses))}. ${gerund} now will ${then}.`;
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
  const what = underWay(busy, true);
  const then = what.runningOnly
    ? `Stop ${what.obj}`
    : what.running
      ? "Stop or wait for them"
      : `Wait for ${what.obj} to finish`;
  return `On that device, ${listed(what.clauses)}. ${then} before ${verb}.`;
}

// Why a change of this device's own can't start while the work under
// way runs (the data-folder move), or null when nothing does.
export function busyRefusal(busy: BusyOperations): string | null {
  if (!isBusy(busy)) return null;
  const what = underWay(busy);
  return `${capitalized(listed(what.clauses))}. Try again when ${what.obj === "it" ? "it finishes" : "they finish"}.`;
}
