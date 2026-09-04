// The git half of a mirrored worktree (PRODUCT.md: "both sides are
// real git worktrees whose branch, commits, and uncommitted changes
// agree"). The file-sync engine keeps the working tree identical. This
// module makes the rest of what `git status` shows agree too. A
// worktree's git state, for mirroring purposes, is three facts:
//
//   - HEAD: the branch it is on (or detached),
//   - the tip: the commit HEAD resolves to,
//   - the index: WHAT is staged, as the tree the index would commit.
//
// The index is captured as a tree rather than as the index file, since
// the file is full of machine-specific stat data and lock semantics.
// When that tree differs from HEAD's (something is staged), it is
// wrapped in a throwaway commit on refs/shigomori/index/<worktreeId>
// so the existing bundle transfer can carry it. When nothing is
// staged, the ref is removed and the tree is HEAD's own.
//
// Reads are made cheap because the follower reads on every signal and
// on a sweep: one rev-parse answers HEAD, the tip, the tip's tree and
// the git dir together. The index tree is recomputed only when the
// index file's size or mtime moved, from a scratch copy so write-tree
// never touches the real index (it would echo through every index
// watcher, this module's included).
//
// Applying a state is deliberately narrow and guarded: refs move by
// compare-and-set against the state the caller last saw, branch
// collisions refuse with the path that holds the branch, and the
// working tree is never touched (the engine owns it). read-tree plus
// an index refresh is what makes the staged view match without
// rewriting a single file.
import { copyFile, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@shared/schemas";
import { errorMessageOf } from "@shared/errors";
import { run, runLenient } from "@host/lib/git/core";
import {
  deleteRef,
  hasCommit,
  hasObject,
  isAncestor,
  refTip,
  treeOf,
  updateRef,
  ZERO_SHA,
} from "@host/lib/git/refs";
import {
  listWorktreeIdentities,
  worktreeIdFromPath,
} from "@host/lib/git/worktrees";

export type GitHead = { kind: "branch"; branch: string } | { kind: "detached" };

export type GitState = {
  head: GitHead;
  tip: string;
  indexTree: string;
  // The commit carrying indexTree for transfer, or null when the index
  // equals HEAD's tree and there is nothing to carry.
  indexCommit: string | null;
};

// The part of a state that changes hands: head, tip and the staged
// tree. The carrier commit is transport detail.
export type GitStateCore = Pick<GitState, "head" | "tip" | "indexTree">;

export function indexRefFor(worktreeId: string): string {
  return `refs/shigomori/index/${worktreeId}`;
}

// Pinned identity for the carrier commits, so they never depend on
// the machine's git config.
const CAPTURE_IDENT: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "shigomori",
  GIT_AUTHOR_EMAIL: "shigomori@localhost",
  GIT_COMMITTER_NAME: "shigomori",
  GIT_COMMITTER_EMAIL: "shigomori@localhost",
};

// HEAD, the tip, the tip's tree and the git dir in one spawn. An unborn
// HEAD fails the rev-parse, which is the one state this module refuses.
type HeadFacts = {
  head: GitHead;
  tip: string;
  headTree: string;
  gitDir: string;
};

async function readHeadFacts(worktreePath: string): Promise<HeadFacts> {
  let out: string;
  try {
    out = await run(worktreePath, [
      "rev-parse",
      "HEAD",
      "HEAD^{tree}",
      "--symbolic-full-name",
      "HEAD",
      "--absolute-git-dir",
    ]);
  } catch (error) {
    throw new Error(
      `the worktree has no commits yet (${errorMessageOf(error)})`,
      { cause: error },
    );
  }
  const [tip = "", headTree = "", ref = "", gitDir = ""] = out
    .split("\n")
    .map((line) => line.trim());
  if (tip === "" || headTree === "" || gitDir === "") {
    throw new Error("the worktree has no commits yet");
  }
  const head: GitHead = ref.startsWith("refs/heads/")
    ? { kind: "branch", branch: ref.slice("refs/heads/".length) }
    : { kind: "detached" };
  return { head, tip, headTree, gitDir };
}

export async function gitDirOfWorktree(worktreePath: string): Promise<string> {
  const out = await run(worktreePath, ["rev-parse", "--absolute-git-dir"]);
  return out.trim();
}

// The last index tree computed per worktree, keyed on the index file's
// identity (size and mtime): the steady state of a mirrored worktree
// is "unchanged since last look", and that costs one stat.
type IndexSnapshot = { size: number; mtimeMs: number; tree: string };
const indexSnapshots = new Map<string, IndexSnapshot>();

// A stable scratch index per worktree under the OS temp dir, overwritten
// on every recompute, so no directory is minted and removed per read.
// One computation at a time per worktree (below), since two copies
// racing on the same scratch file would hand write-tree a torn index.
function scratchIndexPath(worktreePath: string): string {
  return join(tmpdir(), `sm-index-${worktreeIdFromPath(worktreePath)}`);
}

const indexTreeInFlight = new Map<string, Promise<string>>();

// The tree the index would commit right now. Concurrent readers of one
// worktree (the follower and a peer's gitState call) share one run.
function indexTreeOf(
  worktreePath: string,
  gitDir: string,
  headTree: string,
): Promise<string> {
  const running = indexTreeInFlight.get(worktreePath);
  if (running !== undefined) return running;
  const started = computeIndexTree(worktreePath, gitDir, headTree).finally(
    () => {
      indexTreeInFlight.delete(worktreePath);
    },
  );
  indexTreeInFlight.set(worktreePath, started);
  return started;
}

async function computeIndexTree(
  worktreePath: string,
  gitDir: string,
  headTree: string,
): Promise<string> {
  const indexPath = join(gitDir, "index");
  let identity: { size: number; mtimeMs: number };
  try {
    const info = await stat(indexPath);
    identity = { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    // No index yet (a worktree git has not touched since creation):
    // the index would commit HEAD's tree.
    indexSnapshots.delete(worktreePath);
    return headTree;
  }
  const cached = indexSnapshots.get(worktreePath);
  if (
    cached !== undefined &&
    cached.size === identity.size &&
    cached.mtimeMs === identity.mtimeMs
  ) {
    return cached.tree;
  }
  const copy = scratchIndexPath(worktreePath);
  await copyFile(indexPath, copy);
  let tree: string;
  try {
    tree = (
      await run(worktreePath, ["write-tree"], { env: { GIT_INDEX_FILE: copy } })
    ).trim();
  } catch (error) {
    throw new Error(
      `the index cannot be snapshotted (unresolved conflicts?): ${errorMessageOf(error)}`,
      { cause: error },
    );
  }
  indexSnapshots.set(worktreePath, { ...identity, tree });
  return tree;
}

// The three facts, read-only: nothing is written.
export async function peekGitState(
  worktreePath: string,
): Promise<GitStateCore> {
  const facts = await readHeadFacts(worktreePath);
  const indexTree = await indexTreeOf(
    worktreePath,
    facts.gitDir,
    facts.headTree,
  );
  return { head: facts.head, tip: facts.tip, indexTree };
}

// Worktrees whose carrier ref this process has minted, so the clean
// path deletes the ref only when one may exist. The first read per
// worktree deletes unconditionally, in case a previous run left one.
const carrierKnown = new Set<string>();

// The full state, with the carrier commit for a staged index minted
// (or an obsolete one removed) so the transfer can name it.
export async function readGitState(
  projectPath: string,
  worktreePath: string,
  worktreeId: string,
): Promise<GitState> {
  const facts = await readHeadFacts(worktreePath);
  const indexTree = await indexTreeOf(
    worktreePath,
    facts.gitDir,
    facts.headTree,
  );
  const core: GitStateCore = { head: facts.head, tip: facts.tip, indexTree };
  const ref = indexRefFor(worktreeId);
  if (indexTree === facts.headTree) {
    if (!carrierKnown.has(worktreeId)) {
      await deleteRef(projectPath, ref).catch(() => {});
      carrierKnown.add(worktreeId);
    }
    return { ...core, indexCommit: null };
  }
  carrierKnown.add(worktreeId);
  const existing = await refTip(projectPath, ref);
  if (
    existing !== null &&
    (await treeOf(projectPath, existing)) === indexTree
  ) {
    return { ...core, indexCommit: existing };
  }
  const commit = (
    await run(
      projectPath,
      [
        "commit-tree",
        indexTree,
        "-p",
        facts.tip,
        "-m",
        "shigomori index snapshot",
      ],
      { env: CAPTURE_IDENT },
    )
  ).trim();
  await updateRef(projectPath, ref, commit);
  return { ...core, indexCommit: commit };
}

export type ApplyGitStateInput = {
  // The state the caller last observed here. Anything else means the
  // worktree moved under the caller, and the apply refuses so the
  // caller can look again.
  expect: Pick<GitStateCore, "tip" | "indexTree">;
  state: GitStateCore;
  // App-owned refs to drop once the state landed (a landed incoming
  // branch, a consumed index carrier). Best effort.
  sweep?: string[];
};

export type ApplyGitStateResult =
  | { applied: true }
  | { applied: false; reason: string };

// Moves this worktree's git state to `state`. Returns a refusal rather
// than throwing for every case that is a fact about the repository
// (someone changed it, a branch collision, missing objects), so the
// follower can show the reason and wait. Throws only on git failing
// to do what it was asked.
export async function applyGitState(
  project: Project,
  worktree: { id: string; path: string },
  input: ApplyGitStateInput,
): Promise<ApplyGitStateResult> {
  const current = await peekGitState(worktree.path);
  if (
    current.tip !== input.expect.tip ||
    current.indexTree !== input.expect.indexTree
  ) {
    return { applied: false, reason: "changed-locally" };
  }
  const { state } = input;
  if (
    !(await hasCommit(project.path, state.tip)) ||
    !(await hasObject(project.path, `${state.indexTree}^{tree}`))
  ) {
    return { applied: false, reason: "missing-objects" };
  }

  if (state.head.kind === "branch") {
    const target = state.head.branch;
    const targetRef = `refs/heads/${target}`;
    const currentBranch =
      current.head.kind === "branch" ? current.head.branch : null;
    if (target === currentBranch) {
      if (current.tip !== state.tip) {
        await run(project.path, [
          "update-ref",
          "--end-of-options",
          targetRef,
          state.tip,
          current.tip,
        ]);
      }
    } else {
      // A branch switch. The branch may exist here already: refuse if
      // another worktree holds it (git would too, less clearly) or if
      // it carries commits the incoming tip does not (moving it would
      // orphan them). Otherwise create it or fast-forward it, then
      // point HEAD at it.
      const identities = await listWorktreeIdentities(project.id, project.path);
      const elsewhere = identities.find(
        (w) => w.branch === target && w.path !== worktree.path,
      );
      if (elsewhere !== undefined) {
        return {
          applied: false,
          reason: `branch ${target} is checked out at ${elsewhere.path} on this device`,
        };
      }
      const existingTip = await refTip(project.path, targetRef);
      if (existingTip === null) {
        await run(project.path, [
          "update-ref",
          "--end-of-options",
          targetRef,
          state.tip,
          ZERO_SHA,
        ]);
      } else if (existingTip !== state.tip) {
        if (!(await isAncestor(project.path, existingTip, state.tip))) {
          return {
            applied: false,
            reason: `branch ${target} on this device has commits the other device does not`,
          };
        }
        await run(project.path, [
          "update-ref",
          "--end-of-options",
          targetRef,
          state.tip,
          existingTip,
        ]);
      }
      await run(worktree.path, ["symbolic-ref", "HEAD", targetRef]);
    }
  } else if (current.head.kind !== "detached" || current.tip !== state.tip) {
    await run(worktree.path, [
      "update-ref",
      "--no-deref",
      "--end-of-options",
      "HEAD",
      state.tip,
    ]);
  }

  // The staged view: the index becomes the incoming tree, then a
  // refresh re-stats every entry against the (already mirrored) files
  // so unchanged ones do not read as modified. refresh exits non-zero
  // when files differ from the index, which is the ordinary dirty case.
  await run(worktree.path, ["read-tree", state.indexTree]);
  await runLenient(worktree.path, ["update-index", "-q", "--refresh"]);

  await Promise.all(
    (input.sweep ?? [])
      .filter((ref) => ref.startsWith("refs/shigomori/"))
      .map((ref) => deleteRef(project.path, ref).catch(() => {})),
  );
  return { applied: true };
}

// Fires when the worktree's index file is rewritten (a stage, an
// unstage, a checkout, also git's own refreshes: the consumer compares
// trees to tell them apart). Returns the stop function. Resolves the
// git dir once. A worktree whose git dir moves is a removed worktree.
export async function watchIndexFile(
  worktreePath: string,
  onChange: () => void,
  debounceMs = 300,
): Promise<() => void> {
  const gitDir = await gitDirOfWorktree(worktreePath);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(gitDir, { persistent: false });
  } catch {
    return () => {};
  }
  watcher.on("change", (_event, file) => {
    if (file !== "index") return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  });
  watcher.on("error", () => {});
  return () => {
    if (timer !== null) clearTimeout(timer);
    watcher.close();
  };
}
