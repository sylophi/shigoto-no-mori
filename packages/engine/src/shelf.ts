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
