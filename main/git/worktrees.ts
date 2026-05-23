import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type CommitSummary,
  UNKNOWN_BRANCH,
  type Worktree,
} from "@shared/schemas";
import { Data, Effect } from "effect";
import { readShelvedSet } from "../worktrees/shelved";
import { readShigomoriConfig } from "../config/project";
import { pickWorktreeName } from "../worktrees/names";
import {
  isManagedPath,
  managedPrefixesFor,
  resolveWorktreeBase,
} from "../worktrees/paths";
import { Git, type GitService, runGitProgram } from "./core";
import {
  fetchRemoteRef,
  listRemotes,
  remoteRefExists,
  splitRemoteRef,
} from "./remotes";

class WorktreeNameCollision extends Data.TaggedError("WorktreeNameCollision")<{
  readonly worktreeName: string;
}> {
  override get message(): string {
    return `A worktree folder named "${this.worktreeName}" already exists in this project.`;
  }
}

class CheckoutBaseRequired extends Data.TaggedError(
  "CheckoutBaseRequired",
)<{}> {
  override get message(): string {
    return "Checkout mode requires a base ref";
  }
}

class WorktreeDisappeared extends Data.TaggedError("WorktreeDisappeared")<{}> {
  override get message(): string {
    return "Worktree disappeared after creation";
  }
}

const mkdirEffect = (path: string) =>
  Effect.promise(() => mkdir(path, { recursive: true })).pipe(Effect.asVoid);

const rmEffect = (path: string) =>
  Effect.promise(() => rm(path, { recursive: true, force: true })).pipe(
    Effect.asVoid,
  );

const readShigomoriConfigOrNull = (projectId: string) =>
  Effect.promise(() => readShigomoriConfig(projectId).catch(() => null));

const listRemotesEffect = (projectPath: string) =>
  Effect.promise(() => listRemotes(projectPath));

const remoteRefExistsEffect = (projectPath: string, ref: string) =>
  Effect.promise(() => remoteRefExists(projectPath, ref));

const fetchRemoteRefLenient = (
  projectPath: string,
  remote: string,
  branch: string,
) =>
  Effect.promise(() =>
    fetchRemoteRef(projectPath, remote, branch).catch(() => undefined),
  );

const splitRemoteRefEffect = (projectPath: string, ref: string) =>
  Effect.promise(() => splitRemoteRef(projectPath, ref));

function runWorktree<A>(
  effect: Effect.Effect<A, unknown, GitService>,
): Promise<A> {
  return runGitProgram(effect);
}

interface RawWorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

function parsePorcelain(stdout: string): RawWorktreeEntry[] {
  const entries: RawWorktreeEntry[] = [];
  let current: Partial<RawWorktreeEntry> = {};

  for (const line of stdout.split("\n")) {
    if (line === "") {
      if (current.path) entries.push(current as RawWorktreeEntry);
      current = {};
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current.path = value;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
  }
  if (current.path) entries.push(current as RawWorktreeEntry);
  return entries;
}

function deriveBranch(entry: RawWorktreeEntry): string {
  if (entry.branch) return entry.branch.replace(/^refs\/heads\//, "");
  if (entry.detached) return entry.head?.slice(0, 7) ?? "detached";
  return UNKNOWN_BRANCH;
}

function getChangedCountEffect(worktreePath: string) {
  return Effect.gen(function* () {
    const stdout = yield* Git.run(worktreePath, ["status", "--porcelain=v1"]);
    return stdout.split("\n").filter((line) => line.length > 0).length;
  }).pipe(Effect.catchAll(() => Effect.succeed(0)));
}

// Probes how the worktree's HEAD relates to its upstream. Failure of the
// rev-list call is taken as "no upstream" -- either the branch was never
// pushed, or HEAD is detached. `divergedClean` runs a `merge-tree`
// probe only when both sides have unique commits; it tells the UI
// whether a whole-tree merge would land cleanly. The action behind
// the "Pull and push" button tries `rebase` first and falls back to
// `merge` on a per-commit conflict, so this probe gates that fallback.
function getRemoteSyncEffect(worktreePath: string) {
  return Effect.gen(function* () {
    const stdout = yield* Git.run(worktreePath, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{u}",
    ]);
    const [a, b] = stdout.trim().split(/\s+/);
    const ahead = Number(a) || 0;
    const behind = Number(b) || 0;
    if (ahead === 0 || behind === 0) {
      return { ahead, behind, hasUpstream: true, divergedClean: false };
    }
    // Diverged: ask git whether a merge would land without conflicts.
    // `merge-tree --write-tree` exits 0 on a clean merge and non-zero
    // when conflicts would arise (or on git < 2.38, where we treat the
    // unknown as "not clean" -- safer default).
    const divergedClean = yield* Git.runVoid(worktreePath, [
      "merge-tree",
      "--write-tree",
      "HEAD",
      "@{u}",
    ]).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    );
    return { ahead, behind, hasUpstream: true, divergedClean };
  }).pipe(
    Effect.catchAll(() =>
      Effect.succeed({
        ahead: 0,
        behind: 0,
        hasUpstream: false,
        divergedClean: false,
      }),
    ),
  );
}

// `--shortstat` appends " N files changed, X insertions(+), Y deletions(-)"
// on its own line after each commit's formatted output. A SOH (\x01)
// sentinel between records keeps parsing robust against subjects that
// contain tabs or newlines.
const LOG_SENTINEL = "\x01";
const LOG_FORMAT = `${LOG_SENTINEL}%h%x09%an%x09%aI%x09%s`;

function parseLog(stdout: string): CommitSummary[] {
  const commits: CommitSummary[] = [];
  for (const chunk of stdout.split(LOG_SENTINEL)) {
    if (!chunk) continue;
    const newlineAt = chunk.indexOf("\n");
    const header = newlineAt === -1 ? chunk : chunk.slice(0, newlineAt);
    const stats = newlineAt === -1 ? "" : chunk.slice(newlineAt + 1);
    const [hash, author, date, ...subjectParts] = header.split("\t");
    if (!hash) continue;
    const insMatch = /(\d+) insertions?\(\+\)/.exec(stats);
    const delMatch = /(\d+) deletions?\(-\)/.exec(stats);
    commits.push({
      hash,
      author: author ?? "",
      date: date ?? "",
      subject: subjectParts.join("\t"),
      additions: insMatch ? Number(insMatch[1]) : 0,
      deletions: delMatch ? Number(delMatch[1]) : 0,
    });
  }
  return commits;
}

// Paginated branch history. `skip` walks back through `git log HEAD` so
// the renderer's infinite-scroll drawer can page in chunks; the teaser
// in the detail page passes skip=0 with a small count. Returns [] on
// any git failure (empty repo, detached state mid-rebase) so callers
// don't have to fork on error.
export async function listCommits(
  worktreePath: string,
  opts: { skip: number; count: number },
): Promise<CommitSummary[]> {
  return runWorktree(listCommitsEffect(worktreePath, opts));
}

function listCommitsEffect(
  worktreePath: string,
  opts: { skip: number; count: number },
) {
  return Effect.gen(function* () {
    const args = ["log", `--skip=${opts.skip}`, `-${opts.count}`];
    args.push(`--pretty=format:${LOG_FORMAT}`, "--shortstat");
    const stdout = yield* Git.run(worktreePath, args);
    return parseLog(stdout);
  }).pipe(Effect.catchAll(() => Effect.succeed<CommitSummary[]>([])));
}

export interface WorktreeIdentity {
  id: string;
  projectId: string;
  // Directory basename — stable identity, separate from the branch.
  name: string;
  branch: string;
  path: string;
  isPrimary: boolean;
  isExternal: boolean;
  detached: boolean;
}

// Derived purely from the absolute worktree path so the same path always
// produces the same id, anywhere. Paths are globally unique on a
// filesystem, so the hash is too. 12 hex chars (48 bits) leaves plenty
// of collision headroom for the handful of worktrees a project holds.
export function worktreeIdFromPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

function listWorktreeIdentitiesEffect(
  projectId: string,
  projectPath: string,
): Effect.Effect<WorktreeIdentity[], unknown, GitService> {
  return Effect.gen(function* () {
    const [stdout, config] = yield* Effect.all(
      [
        Git.run(projectPath, ["worktree", "list", "--porcelain"]),
        readShigomoriConfigOrNull(projectId),
      ],
      { concurrency: "unbounded" },
    );
    // A worktree counts as managed if it sits under any layout we know
    // about (managed root, in-project, or the configured custom path).
    // This keeps mixed states (some worktrees still in the old layout
    // after a partial migration) from mislabeling rows as external.
    const managedPrefixes = managedPrefixesFor(projectPath, config);
    return parsePorcelain(stdout)
      .filter((e) => !e.bare)
      .map((entry, index) => {
        const branch = deriveBranch(entry);
        const isPrimary = entry.path === projectPath || index === 0;
        // Primary checkout sits at the project root, so its "name" is just
        // the project's directory basename. Managed worktrees use the picked
        // animal dirname; external ones use whatever the user named them.
        const name = basename(entry.path);
        return {
          id: worktreeIdFromPath(entry.path),
          projectId,
          name,
          branch,
          path: entry.path,
          isPrimary,
          isExternal: !isManagedPath(entry.path, managedPrefixes),
          detached: entry.detached ?? false,
        };
      });
  });
}

export async function listWorktreeIdentities(
  projectId: string,
  projectPath: string,
): Promise<WorktreeIdentity[]> {
  return runWorktree(listWorktreeIdentitiesEffect(projectId, projectPath));
}

// How many recent commits to surface on the worktree detail page. The
// teaser renders the first 3; the 4th (if present) is what tells the
// renderer there's more history to scroll, so it can show the "Show
// all" affordance without a second round trip.
const RECENT_COMMITS_COUNT = 4;

function buildWorktreeEffect(
  identity: WorktreeIdentity,
  hasRemote: boolean,
  shelvedSet: ReadonlySet<string>,
) {
  return Effect.gen(function* () {
    const [changedCount, recentCommits, remoteSync] = yield* Effect.all(
      [
        getChangedCountEffect(identity.path),
        listCommitsEffect(identity.path, {
          skip: 0,
          count: RECENT_COMMITS_COUNT,
        }),
        getRemoteSyncEffect(identity.path),
      ],
      { concurrency: "unbounded" },
    );
    return {
      id: identity.id,
      projectId: identity.projectId,
      name: identity.name,
      branch: identity.branch,
      path: identity.path,
      ahead: remoteSync.ahead,
      behind: remoteSync.behind,
      hasUpstream: remoteSync.hasUpstream,
      hasRemote,
      divergedClean: remoteSync.divergedClean,
      changedCount,
      recentCommits,
      isPrimary: identity.isPrimary,
      isExternal: identity.isExternal,
      detached: identity.detached,
      shelved:
        !identity.isPrimary &&
        !identity.isExternal &&
        shelvedSet.has(identity.id),
    };
  });
}

export async function listWorktrees(
  projectId: string,
  projectPath: string,
): Promise<Worktree[]> {
  return runWorktree(
    Effect.gen(function* () {
      const [identities, remotes] = yield* Effect.all(
        [
          listWorktreeIdentitiesEffect(projectId, projectPath),
          listRemotesEffect(projectPath),
        ],
        { concurrency: "unbounded" },
      );
      const hasRemote = remotes.length > 0;
      // Single sync disk read of state.json, then per-row lookups are O(1)
      // against the in-memory set. Avoids N readFileSync per list call.
      const shelvedSet = readShelvedSet();
      // Primary first so it anchors the sidebar list as the canonical checkout.
      const ordered = identities.toSorted((a, b) =>
        a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1,
      );
      return yield* Effect.all(
        ordered.map((id) => buildWorktreeEffect(id, hasRemote, shelvedSet)),
        { concurrency: "unbounded" },
      );
    }),
  );
}

export async function describeWorktree(
  identity: WorktreeIdentity,
  projectPath: string,
): Promise<Worktree> {
  return runWorktree(
    Effect.gen(function* () {
      const remotes = yield* listRemotesEffect(projectPath);
      return yield* buildWorktreeEffect(
        identity,
        remotes.length > 0,
        readShelvedSet(),
      );
    }),
  );
}

export async function findWorktreeIdentityOrThrow(
  projectId: string,
  projectPath: string,
  worktreeId: string,
): Promise<WorktreeIdentity> {
  const identities = await runWorktree(
    listWorktreeIdentitiesEffect(projectId, projectPath),
  );
  const identity = identities.find((w) => w.id === worktreeId);
  if (!identity) throw new Error(`Unknown worktree: ${worktreeId}`);
  return identity;
}

export function deriveProjectName(path: string): string {
  return basename(path);
}

export async function pickAvailableWorktreeName(
  projectId: string,
  projectPath: string,
): Promise<string> {
  const existing = await runWorktree(
    listWorktreeIdentitiesEffect(projectId, projectPath),
  );
  const used = new Set(existing.map((w) => w.name));
  return pickWorktreeName(used);
}

interface CreateWorktreeOptions {
  requestedWorktreeName?: string;
  branchName?: string;
  base?: string;
  checkout: boolean;
}

export async function createWorktree(
  projectId: string,
  projectPath: string,
  opts: CreateWorktreeOptions,
): Promise<Worktree> {
  return runWorktree(
    Effect.gen(function* () {
      const { requestedWorktreeName, branchName, base, checkout } = opts;
      // Dirname is decoupled from the branch — a random animal that isn't
      // already used by another worktree in this project. When the caller
      // supplies a name we treat it as a user-chosen destination and fail
      // loudly on collision; only the unset case falls back to an animal
      // pick (the renderer's pre-pick also flows through here).
      const existing = yield* listWorktreeIdentitiesEffect(
        projectId,
        projectPath,
      );
      const used = new Set(existing.map((w) => w.name));
      if (requestedWorktreeName && used.has(requestedWorktreeName)) {
        return yield* Effect.fail(
          new WorktreeNameCollision({ worktreeName: requestedWorktreeName }),
        );
      }
      const worktreeName = requestedWorktreeName || pickWorktreeName(used);
      const config = yield* readShigomoriConfigOrNull(projectId);
      const worktreePath = join(
        resolveWorktreeBase(projectPath, config),
        worktreeName,
      );

      // Refresh remote-tracking refs so the new worktree starts at the actual
      // upstream tip. Without this, `refs/remotes/origin/main` is whatever the
      // last fetch left behind -- which often matches local `main` and looks
      // like the worktree silently used the local branch as its base.
      if (base && (yield* remoteRefExistsEffect(projectPath, base))) {
        const split = yield* splitRemoteRefEffect(projectPath, base);
        if (split) {
          yield* fetchRemoteRefLenient(projectPath, split.remote, split.branch);
        }
      }

      yield* mkdirEffect(dirname(worktreePath));
      if (checkout) {
        if (!base) return yield* Effect.fail(new CheckoutBaseRequired());
        // No `-b`: reuse the existing branch in this new worktree. git
        // refuses if the branch is already checked out in another worktree.
        yield* Git.runVoid(projectPath, [
          "worktree",
          "add",
          worktreePath,
          base,
        ]);
      } else {
        // Quick-create: when the caller doesn't specify a branch, reuse the
        // animal dirname so the branch and worktree start aligned.
        const branch = branchName?.trim() || worktreeName;
        const args = ["worktree", "add", "-b", branch, worktreePath];
        if (base) args.push(base);
        yield* Git.runVoid(projectPath, args);
      }
      // Re-read identity from `git worktree list` so the returned worktree's
      // branch reflects what git actually settled on (e.g. checking out
      // `origin/main` creates a local `main` tracking branch).
      const [fresh, remotes] = yield* Effect.all(
        [
          listWorktreeIdentitiesEffect(projectId, projectPath),
          listRemotesEffect(projectPath),
        ],
        { concurrency: "unbounded" },
      );
      const identity = fresh.find((w) => w.path === worktreePath);
      if (!identity) return yield* Effect.fail(new WorktreeDisappeared());
      return yield* buildWorktreeEffect(
        identity,
        remotes.length > 0,
        readShelvedSet(),
      );
    }),
  );
}

export async function removeWorktree(
  projectPath: string,
  worktreePath: string,
  force: boolean,
): Promise<void> {
  const args = ["worktree", "remove", worktreePath];
  if (force) args.push("--force");
  return runWorktree(Git.runVoid(projectPath, args));
}

// Force-removes a worktree, falling back to a manual wipe when git's
// recursive rmdir fails with ENOTEMPTY (untracked content git couldn't
// sweep -- caches, files held open). We don't retry `git worktree
// remove` after fs.rm because once the dir is gone, remove errors out
// on "not on disk". Other failures (corrupt repo, EACCES) rethrow so
// real bugs stay visible.
export async function removeWorktreeForce(
  projectPath: string,
  worktreePath: string,
): Promise<void> {
  try {
    await removeWorktree(projectPath, worktreePath, true);
    return;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Directory not empty|ENOTEMPTY/i.test(msg)) {
      throw err;
    }
    console.warn(`[worktrees] force-wipe fallback: ${msg}`);
  }
  return runWorktree(
    Effect.gen(function* () {
      yield* rmEffect(worktreePath);
      yield* Git.runVoid(projectPath, ["worktree", "prune"]);
    }),
  );
}

// Drops admin entries under $GIT_DIR/worktrees whose checkout dir is
// gone. Used after a fallback fs.rm and after the nuke-everything root
// wipe to keep `git worktree list` honest.
export async function pruneStaleWorktrees(projectPath: string): Promise<void> {
  return runWorktree(Git.runVoid(projectPath, ["worktree", "prune"]));
}

// Moves a worktree's checkout to a new directory. `git worktree move`
// preserves the working tree, index, and untracked files; the absolute
// carry-over symlinks stay valid because their targets don't change. Git
// refuses if the worktree is locked, dirty in a way that conflicts with
// the move, or the destination already exists.
export async function relocateWorktree(
  projectPath: string,
  oldPath: string,
  newPath: string,
): Promise<void> {
  return runWorktree(
    Effect.gen(function* () {
      yield* mkdirEffect(dirname(newPath));
      yield* Git.runVoid(projectPath, ["worktree", "move", oldPath, newPath]);
    }),
  );
}
