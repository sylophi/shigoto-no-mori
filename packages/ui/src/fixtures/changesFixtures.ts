// The changes page's working tree, per worktree: which files are
// changed, how much of each is staged, and a patch for whichever one is
// picked. Seeded from the fixture's `changedCount` the first time a
// worktree is read, then kept, so committing and discarding show their
// outcome and the commit → push flow runs end to end.
import type {
  ChangedFile,
  CommitPicks,
  CommitSummary,
} from "@shigomori/contracts/schemas/index";
import { UnknownWorktreeError } from "@shigomori/contracts/errors";
import type { FakeWorktree } from "./fixtures.ts";

// The files a worktree's changes are drawn from: the first
// `changedCount` of them, then sorted by path like git status. One of
// each kind, a deep path and a long name, and enough of them (8) for
// the list's filter, so the marks, the truncation and the filter all
// show.
const POOL: readonly ChangedFile[] = [
  {
    path: "renderer/components/diff/CommitComposer.tsx",
    kind: "modified",
    counts: { additions: 38, deletions: 14 },
    staged: "none",
  },
  {
    path: "renderer/components/sidebar/DeviceBadge.tsx",
    kind: "added",
    counts: { additions: 7, deletions: 0 },
    // In the index the way an agent's `git add` leaves a file, which the
    // page's ticks pay no mind to.
    staged: "all",
  },
  {
    path: "renderer/lib/toast.tsx",
    kind: "modified",
    counts: { additions: 4, deletions: 1 },
    staged: "none",
  },
  {
    path: "renderer/lib/villagerVoice.ts",
    kind: "modified",
    counts: { additions: 12, deletions: 3 },
    staged: "none",
  },
  {
    path: "renderer/components/worktreeDetail/commits/useWorktreeSyncAvailability.ts",
    prevPath: "renderer/components/worktreeDetail/commits/useSyncState.ts",
    kind: "renamed",
    counts: { additions: 2, deletions: 2 },
    staged: "none",
  },
  {
    path: "shared/legacy/oldStatus.ts",
    kind: "deleted",
    counts: { additions: 0, deletions: 21 },
    staged: "none",
  },
  {
    path: "app/test/proofs/commitComposer.test.ts",
    kind: "added",
    counts: { additions: 64, deletions: 0 },
    staged: "none",
  },
  {
    path: "README.md",
    kind: "modified",
    counts: { additions: 3, deletions: 0 },
    staged: "none",
  },
];

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
    // HEAD moves. A file here has one change, so one ticked by hunk goes
    // whole.
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

    // The picked file's one change, as patchFor draws it: past three
    // lines of context, its deletions then its additions.
    hunks: (worktreeId: string, path: string) => {
      const file = filesOf(worktreeId).find((f) => f.path === path);
      const adds = file?.counts?.additions ?? 0;
      const dels = file?.counts?.deletions ?? 0;
      const head = findWorktree(worktreeId)?.recentCommits[0]?.hash ?? "0000";
      if (!file || file.kind !== "modified" || adds + dels === 0) {
        return { head, changes: [] };
      }
      return {
        head,
        changes: [
          {
            oldStart: dels === 0 ? 3 : 4,
            oldCount: dels,
            newStart: adds === 0 ? 3 : 4,
            newCount: adds,
          },
        ],
      };
    },

    // The patch for one picked file: a hunk the size of its counts.
    fileDiff: (worktreeId: string, paths: readonly string[]) => {
      const path = paths.at(-1) ?? "";
      const file = filesOf(worktreeId).find((f) => f.path === path);
      if (!file) return "";
      return patchFor(file);
    },
  };
}

const CODE = [
  'import { cn } from "@/lib/utils";',
  'import { pluralize } from "@/lib/pluralize";',
  'import type { ChangedFile } from "@shigomori/contracts/schemas";',
  "",
  "// What the button says it will do.",
  "export function label(count: number, amending: boolean): string {",
  '  const what = pluralize(count, "file");',
  "  return amending ? `Amend with ${what}` : `Commit ${what}`;",
  "}",
  "",
  "export function tone(ahead: number): string {",
  '  return ahead > 0 ? "text-emerald-500" : "text-muted-foreground";',
  "}",
  "",
  "export function included(files: readonly ChangedFile[]): number {",
  '  return files.filter((file) => file.staged !== "none").length;',
  "}",
  "",
  "export const SUMMARY_SOFT_LIMIT = 72;",
  "",
  "export function overLimit(summary: string): boolean {",
  "  return summary.trim().length > SUMMARY_SOFT_LIMIT;",
  "}",
  "",
  'export const scope = (all: boolean) => (all ? "all" : "some");',
];

function lines(count: number, offset: number): string[] {
  return Array.from(
    { length: count },
    (_, i) => CODE[(i + offset) % CODE.length] ?? "",
  );
}

function patchFor(file: ChangedFile): string {
  const adds = file.counts?.additions ?? 0;
  const dels = file.counts?.deletions ?? 0;
  const from = file.prevPath ?? file.path;
  const head = [`diff --git a/${from} b/${file.path}`];
  if (file.kind === "added") {
    head.push("new file mode 100644", "--- /dev/null", `+++ b/${file.path}`);
    return [
      ...head,
      `@@ -0,0 +1,${adds} @@`,
      ...lines(adds, 0).map((l) => `+${l}`),
      "",
    ].join("\n");
  }
  if (file.kind === "deleted") {
    head.push("deleted file mode 100644", `--- a/${from}`, "+++ /dev/null");
    return [
      ...head,
      `@@ -1,${dels} +0,0 @@`,
      ...lines(dels, 3).map((l) => `-${l}`),
      "",
    ].join("\n");
  }
  if (file.kind === "renamed") {
    head.push(`rename from ${from}`, `rename to ${file.path}`);
  }
  head.push(`--- a/${from}`, `+++ b/${file.path}`);
  const context = lines(3, 0);
  return [
    ...head,
    `@@ -1,${context.length + dels} +1,${context.length + adds} @@`,
    ...context.map((l) => ` ${l}`),
    ...lines(dels, 4).map((l) => `-${l}`),
    ...lines(adds, 6).map((l) => `+${l}`),
    "",
  ].join("\n");
}
