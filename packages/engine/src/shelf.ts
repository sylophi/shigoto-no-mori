import { type AgentSession, anyActive } from "./agentSessions.ts";

// A shelved worktree comes back off the shelf on its own once it is
// worked in: an edit, a new or deleted file, or a commit. Changes it was
// shelved with don't count, and neither does an auto-pull fast-forward.
//
// The full listing already probes every row's HEAD and changes, so the
// check costs no git of its own: the first listing that sees a worktree
// shelved records a snapshot of it, and a later listing that finds it
// moved past that snapshot unshelves it. The identity listing runs no
// probes and settles nothing.

// A shelved worktree as the first listing after the shelve saw it.
// `head` is null when the log came back empty: no commits yet, or a
// failed read.
export type ShelfSnapshot = {
  readonly at: number;
  readonly head: string | null;
  readonly changed: number;
};

// What one listing saw of a shelved worktree.
export type ShelfObservation = {
  // When the row's probes started, epoch ms: a snapshot taken from them
  // covers every change older than this.
  readonly at: number;
  // The newest commit's abbreviated hash, "" when there is none.
  readonly head: string;
  readonly changed: number;
  // Newest mtime among the changed paths, 0 when none was read.
  readonly lastChangeAt: number;
  // An auto-pull worktree with nothing unpushed: the app fast-forwards
  // it on its own, so a HEAD move there is the pull and not the user.
  readonly followsUpstream: boolean;
};

export const snapshotOf = (seen: ShelfObservation): ShelfSnapshot => ({
  at: seen.at,
  head: seen.head === "" ? null : seen.head,
  changed: seen.changed,
});

// Git lengthens abbreviated hashes as a repository grows, so the same
// commit can come back a character longer than it was recorded. A head
// the snapshot couldn't read compares as unknown: a first commit still
// shows in the changed count.
const sameCommit = (seen: string, recorded: string | null) =>
  recorded === null || seen.startsWith(recorded) || recorded.startsWith(seen);

// Whether the worktree moved past its snapshot. The mtime check only
// sees the paths the change probe stats, so a new edit to one path in a
// very dirty tree can slip past it. The count still catches any path
// that becomes, or stops being, changed.
export const shelfWorked = (
  snapshot: ShelfSnapshot,
  seen: ShelfObservation,
): boolean =>
  (seen.head !== "" &&
    !sameCommit(seen.head, snapshot.head) &&
    !seen.followsUpstream) ||
  seen.changed !== snapshot.changed ||
  seen.lastChangeAt > snapshot.at;

// The idle shelf: with the autoShelveDays setting on, the same listings
// shelve a managed worktree nothing has touched for that many days,
// its snapshot taken in the same write. A touch is a commit or other
// move of HEAD, an edit, an agent session changing state, the
// worktree's creation, or an unshelve, by hand or by work. A pull into
// an auto-pull worktree isn't one, as above.

// Past a century the count means never.
const MAX_IDLE_SHELF_DAYS = 36500;
const DAY_MS = 24 * 60 * 60 * 1000;

// How long a worktree may go untouched, ms, from the autoShelveDays
// setting's value: 0 while it is off.
export const idleShelfAfter = (days: unknown): number =>
  typeof days === "number" && Number.isInteger(days) && days > 0
    ? Math.min(days, MAX_IDLE_SHELF_DAYS) * DAY_MS
    : 0;

// What the idle shelf reads of a row.
export type TouchedRow = {
  readonly isPrimary: boolean;
  readonly isExternal: boolean;
  readonly lastChangeAt?: number | undefined;
  readonly createdAt?: number | undefined;
  readonly autoPull: boolean;
  readonly unpushedCount: number;
  readonly recentCommits: ReadonlyArray<{ readonly date: string }>;
  readonly agentSessions?: ReadonlyArray<AgentSession> | undefined;
};

// The newest touch the row shows (the app's worktreeLastActivityAt,
// plus its creation), HEAD's last move (`headMovedAt`, the mtime of its
// HEAD reflog), or the unshelve, epoch ms. 0 when nothing is known. A
// commit's own date can be old (a rebase or a checkout keeps it), so
// the reflog stands in for the move itself. Neither counts where HEAD
// only follows its upstream.
export const lastTouchedAt = (
  row: TouchedRow,
  headMovedAt: number,
  unshelvedAt: number,
): number => {
  const followsUpstream = row.autoPull && row.unpushedCount === 0;
  const committed = Date.parse(row.recentCommits[0]?.date ?? "");
  return Math.max(
    row.lastChangeAt ?? 0,
    row.createdAt ?? 0,
    unshelvedAt,
    followsUpstream || Number.isNaN(committed) ? 0 : committed,
    followsUpstream ? 0 : headMovedAt,
    ...(row.agentSessions ?? []).map((session) => session.at),
  );
};

// Whether the idle shelf could take an unshelved row at all: a managed
// worktree with no agent session mid-turn, whose time is when the turn
// started (or when it began waiting on the user).
export const idleShelfCandidate = (row: TouchedRow) =>
  !row.isPrimary && !row.isExternal && !anyActive(row.agentSessions ?? []);

// Whether the idle shelf takes a candidate probed at `at`: its newest
// touch is older than `after` allows. One with no touch known is left
// out.
export const idleShelfTakes = (touched: number, at: number, after: number) =>
  after > 0 && touched > 0 && touched < at - after;
