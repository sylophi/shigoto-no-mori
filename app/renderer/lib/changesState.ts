// What the changes page says about the working tree, from its own read
// and the worktree's row. The row's count stands in until the page's
// read arrives. A failed read is not a read still coming: it says so
// (the query's toast has the details) instead of spinning on, and a
// read that fails after one that answered (git can't read its index
// anymore) isn't the last answer standing, which would read as no
// changes.
export function changesState<File>(
  files: readonly File[] | undefined,
  statusError: unknown,
  rowCount: number,
): {
  failed: boolean;
  loading: boolean;
  // Null when the changes couldn't be read.
  changedCount: number | null;
  list: readonly File[];
} {
  const failed = statusError !== null && statusError !== undefined;
  return {
    failed,
    loading: files === undefined && !failed,
    changedCount: failed ? null : (files?.length ?? rowCount),
    list: failed ? [] : (files ?? []),
  };
}

// What moves on the worktree's row when its working tree does: its
// count and its newest change, which the tree's watch reports. The
// page reads its changes again when it moves, for an edit made while
// the window keeps the focus.
export const treeMovedKey = (row: {
  changedCount: number;
  lastChangeAt?: number | undefined;
}) => `${row.changedCount}:${row.lastChangeAt ?? ""}`;
