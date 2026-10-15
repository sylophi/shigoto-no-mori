// The changes page's working tree, per worktree: which files are
// changed, how much of each is staged, and a patch for whichever one is
// picked. Seeded from the fixture's `changedCount` the first time a
// worktree is read, then kept, so committing and discarding show their
// outcome and the commit → push flow runs end to end.
import type {
  ChangedFile,
  CommitPicks,
  CommitSummary,
} from "@shigomori/contracts/schemas";
import { UnknownWorktreeError } from "@shigomori/contracts/errors";
import type { FakeWorktree } from "./fixtures.ts";
import { CHANGE_PATCHES } from "./patches.ts";

// The files a worktree's changes are drawn from: the first
// `changedCount` of them, then sorted by path like git status. One of
// each kind, a deep path and a long name, and enough of them (8) for
// the list's filter, so the marks, the truncation and the filter all
// show. Each one's patch, counts and hunks are git's (patches.ts).
function changeOf(path: string) {
  const change = CHANGE_PATCHES[path];
  if (change === undefined) throw new Error(`no fixture patch for ${path}`);
  return change;
}

const POOL: readonly ChangedFile[] = (
  [
    {
      path: "renderer/components/diff/CommitComposer.tsx",
      kind: "modified",
      staged: "none",
    },
    {
      path: "renderer/components/sidebar/DeviceBadge.tsx",
      kind: "added",
      // In the index the way an agent's `git add` leaves a file, which the
      // page's ticks pay no mind to.
      staged: "all",
    },
    {
      path: "renderer/lib/toast.tsx",
      kind: "modified",
      staged: "none",
    },
    {
      path: "renderer/lib/villagerVoice.ts",
      kind: "modified",
      staged: "none",
    },
    {
      path: "renderer/components/worktreeDetail/commits/useWorktreeSyncAvailability.ts",
      prevPath: "renderer/components/worktreeDetail/commits/useSyncState.ts",
      kind: "renamed",
      staged: "none",
    },
    {
      path: "shared/legacy/oldStatus.ts",
      kind: "deleted",
      staged: "none",
    },
    {
      path: "app/test/proofs/commitComposer.test.ts",
      kind: "added",
      staged: "none",
    },
    {
      path: "README.md",
      kind: "modified",
      staged: "none",
    },
  ] satisfies Omit<ChangedFile, "counts">[]
).map((file) => Object.assign(file, { counts: changeOf(file.path).counts }));

const byPath = (a: ChangedFile, b: ChangedFile) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const touches = (file: ChangedFile, paths: ReadonlySet<string>) =>
  paths.has(file.path) ||
  (file.prevPath !== undefined && paths.has(file.prevPath));

export function createFakeChanges(
  findWorktree: (worktreeId: string) => FakeWorktree | undefined,
) {
  const trees = new Map<string, ChangedFile[]>();

  // Seeded again whenever the row's count moved behind the tree's back
  // (a posing control), so the two never disagree.
  const filesOf = (worktreeId: string): ChangedFile[] => {
    const count = findWorktree(worktreeId)?.changedCount ?? 0;
    let files = trees.get(worktreeId);
    if (!files || files.length !== count) {
      files = POOL.slice(0, count).toSorted(byPath);
      trees.set(worktreeId, files);
    }
    return files;
  };

  const settle = (worktreeId: string, files: ChangedFile[]) => {
    trees.set(worktreeId, files);
    const worktree = findWorktree(worktreeId);
    if (worktree) worktree.changedCount = files.length;
    return worktree;
  };

  return {
    status: (worktreeId: string) => filesOf(worktreeId),

    // What the host's commit does to the tree: the picked files go, and
    // HEAD moves. A file ticked by any of its hunks goes whole: the
    // fixture keeps no file half committed.
    commit: (
      worktreeId: string,
      {
        summary,
        paths,
        hunks,
        amend,
      }: CommitPicks & { summary?: string; amend?: boolean },
    ) => {
      const worktree = findWorktree(worktreeId);
      if (!worktree) throw new UnknownWorktreeError({ worktreeId });
      const listed = new Set([...paths, ...hunks.map((h) => h.path)]);
      const files = filesOf(worktreeId);
      const taken = files.filter((file) => touches(file, listed));
      if (taken.length === 0 && !amend) throw new Error("Nothing to commit");
      const hash = Math.random().toString(16).slice(2, 9);
      const total = (side: "additions" | "deletions") =>
        taken.reduce((n, f) => n + (f.counts?.[side] ?? 0), 0);
      // An amend without a summary keeps the last commit's.
      const subject = summary ?? worktree.recentCommits[0]?.subject ?? "";
      const made: CommitSummary = {
        hash,
        subject,
        author: "sylophi",
        date: new Date().toISOString(),
        additions: total("additions"),
        deletions: total("deletions"),
      };
      if (amend) {
        worktree.recentCommits = [made, ...worktree.recentCommits.slice(1)];
      } else {
        worktree.recentCommits = [made, ...worktree.recentCommits].slice(0, 4);
        worktree.ahead += 1;
        worktree.unpushedCount += 1;
      }
      worktree.lastChangeAt = Date.now();
      settle(
        worktreeId,
        files.filter((file) => !taken.includes(file)),
      );
      return { hash, worktree };
    },

    discard: (worktreeId: string, paths: readonly string[]) => {
      const set = new Set(paths);
      const worktree = settle(
        worktreeId,
        filesOf(worktreeId).filter((file) => !touches(file, set)),
      );
      if (!worktree) throw new UnknownWorktreeError({ worktreeId });
      return { snapshot: "5eed5ab", worktree };
    },

    // The picked file's changes, as git's -U0 diff gives the hunk
    // ticks them.
    hunks: (worktreeId: string, path: string) => {
      const file = filesOf(worktreeId).find((f) => f.path === path);
      const head = findWorktree(worktreeId)?.recentCommits[0]?.hash ?? "0000";
      if (!file || file.kind !== "modified") return { head, changes: [] };
      return { head, changes: changeOf(path).hunks };
    },

    // The patch for one picked file.
    fileDiff: (worktreeId: string, paths: readonly string[]) => {
      const path = paths.at(-1) ?? "";
      const file = filesOf(worktreeId).find((f) => f.path === path);
      if (!file) return "";
      return changeOf(file.path).patch;
    },
  };
}
