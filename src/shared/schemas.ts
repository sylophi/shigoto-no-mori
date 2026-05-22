// Zod schemas for IPC validation. Types in shared/types.ts derive from these.
import { z } from "zod";

export const CommitSummarySchema = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
  // Net additions/deletions across all files in this commit, parsed
  // from `git log --shortstat`. Zero for empty/merge commits.
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

// Sentinel returned by `deriveBranch` when a worktree has no branch and
// no detached HEAD we can read. Treated as "not a real branch" by every
// consumer that filters branches for operations (delete, switch, etc.).
export const UNKNOWN_BRANCH = "(unknown)";

export const isRealBranch = (branch: string): boolean =>
  branch !== UNKNOWN_BRANCH;

export const PullRequestStateSchema = z.enum(["OPEN", "CLOSED", "MERGED"]);

export const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  title: z.string(),
  state: PullRequestStateSchema,
  isDraft: z.boolean(),
});

export const WorktreeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  // The worktree's identity — directory basename. Stable across branch
  // checkouts/renames; for shigomori-created worktrees it's a randomly
  // picked animal name.
  name: z.string(),
  // The currently checked-out branch. A *property* of the worktree, not
  // its identity. May change via `git checkout` / `git branch -m`.
  branch: z.string(),
  path: z.string(),
  // Commits this worktree has that its upstream doesn't, and vice versa.
  // Both 0 when synced, when there's no upstream, or when HEAD is
  // detached -- consumers should check `hasUpstream` to disambiguate.
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  // True when the branch has an upstream configured AND that upstream
  // still resolves (i.e. `@{u}` works). False for detached HEAD, brand-
  // new local branches, or branches whose tracked remote was deleted.
  hasUpstream: z.boolean(),
  // True when the project has at least one git remote configured. Drives
  // whether "Publish" is offered as an action versus only as a hint.
  hasRemote: z.boolean(),
  // Only meaningful when ahead > 0 && behind > 0. True when a merge
  // probe (`git merge-tree --write-tree`) reports no conflicts. The
  // Pull-and-push action tries `git rebase @{u}` first (linear history)
  // and falls back to `git merge @{u}` if a per-commit replay would
  // conflict -- the probe guarantees the merge will land.
  divergedClean: z.boolean(),
  changedCount: z.number().int().nonnegative(),
  // Most-recent first. Empty when the worktree has no commits yet.
  // Bounded by the backend (currently 3) so the IPC payload stays small.
  recentCommits: z.array(CommitSummarySchema),
  port: z.number().int().positive().optional(),
  // The repo's primary checkout. Shown in the UI for context but never
  // removable — deleting it would mean detaching the project itself.
  isPrimary: z.boolean(),
  // True when the worktree lives outside shigomori's managed worktrees dir
  // (i.e. created manually or by another tool). Primary checkouts are also
  // technically external; the UI tags only non-primary externals.
  isExternal: z.boolean(),
  // True when HEAD points at a commit rather than a branch. In this case
  // `branch` holds the short commit hash, not a real branch name — so
  // rename is impossible and the UI styles it as a hash, not a branch.
  detached: z.boolean(),
});

// A worktree's relationship to its upstream, derived from the raw counts
// on Worktree. The renderer switches on `kind` to pick the right pill;
// the backend just reports facts so it stays dumb. "publish" covers
// both "no upstream / remote exists" and "no upstream / no remote",
// distinguished by `canPublish` so the UI can disable the button.
export type RemoteSyncState =
  | { kind: "detached" }
  | { kind: "synced" }
  | { kind: "publish"; canPublish: boolean }
  | { kind: "ahead"; ahead: number }
  | { kind: "behind"; behind: number }
  | { kind: "pullAndPush"; ahead: number; behind: number }
  | { kind: "diverged"; ahead: number; behind: number };

export function deriveRemoteSyncState(
  worktree: Pick<
    Worktree,
    | "ahead"
    | "behind"
    | "hasUpstream"
    | "hasRemote"
    | "divergedClean"
    | "detached"
    | "branch"
  >,
): RemoteSyncState {
  if (worktree.detached || !isRealBranch(worktree.branch)) {
    return { kind: "detached" };
  }
  if (!worktree.hasUpstream) {
    return { kind: "publish", canPublish: worktree.hasRemote };
  }
  if (worktree.ahead === 0 && worktree.behind === 0) return { kind: "synced" };
  if (worktree.behind === 0) return { kind: "ahead", ahead: worktree.ahead };
  if (worktree.ahead === 0) return { kind: "behind", behind: worktree.behind };
  if (worktree.divergedClean) {
    return {
      kind: "pullAndPush",
      ahead: worktree.ahead,
      behind: worktree.behind,
    };
  }
  return { kind: "diverged", ahead: worktree.ahead, behind: worktree.behind };
}

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  // Populated by ProjectsList only — `false` means the project's path is
  // missing on disk (deleted/moved/unmounted). Other handlers don't set it.
  pathExists: z.boolean().optional(),
});

export const AddProjectPayloadSchema = z.object({
  path: z.string(),
});

export const RemoveProjectPayloadSchema = z.object({
  id: z.string(),
});

export const ReorderProjectsPayloadSchema = z.object({
  draggedId: z.string(),
  targetId: z.string(),
  position: z.enum(["before", "after"]),
});

export const ListWorktreesPayloadSchema = z.object({
  projectId: z.string(),
});

export const ProjectsDefaultBranchPayloadSchema = z.object({
  projectId: z.string(),
});

export const ProjectsListBranchesPayloadSchema = z.object({
  projectId: z.string(),
});

export const PickWorktreeNamePayloadSchema = z.object({
  projectId: z.string(),
});

export const ListIgnoredPathsPayloadSchema = z.object({
  projectId: z.string(),
});

export const BranchListSchema = z.object({
  local: z.array(z.string()),
  remote: z.array(z.string()),
});
export type BranchList = z.infer<typeof BranchListSchema>;

export const CreateWorktreePayloadSchema = z.object({
  projectId: z.string(),
  // Optional: caller-picked animal dirname. Falls back to the backend's
  // own pick when omitted or when the requested name is already in use.
  worktreeName: z.string().min(1).optional(),
  // Optional: when omitted, the worktree's auto-picked animal name is
  // used as the branch name too (the quick-create shortcut).
  branchName: z.string().min(1).optional(),
  base: z.string().optional(),
  // When true: check out `base` as the worktree's branch (no -b, no new
  // branch). Requires `base` to be set and not already checked out
  // elsewhere. Ignores `branchName`.
  checkout: z.boolean().optional(),
});

export const CarryOverFailureSchema = z.object({
  path: z.string(),
  reason: z.string(),
});

export const CarryOverReportSchema = z.object({
  applied: z.number().int().nonnegative(),
  failures: z.array(CarryOverFailureSchema),
});

export const ScriptFailureSchema = z.object({
  phase: z.enum(["setup", "portPoolProvision"]),
  exitCode: z.number().nullable(),
  runId: z.string(),
});

export type ScriptFailure = z.infer<typeof ScriptFailureSchema>;

export const CreateWorktreeResultSchema = z.object({
  worktree: WorktreeSchema,
  carryOver: CarryOverReportSchema,
  scriptFailures: z.array(ScriptFailureSchema),
});

export const ConvertExternalWorktreePayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
});

export const RelocateWorktreePayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  // Absolute target directory for the moved worktree (parent is
  // created if it doesn't exist).
  destinationPath: z.string().min(1),
});

export const DeleteWorktreePayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  force: z.boolean().optional(),
  skipCleanup: z.boolean().optional(),
});

export const RenameBranchPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  newBranch: z.string().min(1),
});

export const CheckoutBranchPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  branch: z.string().min(1),
});

// Every remote-sync mutation operates on a single worktree, so payload
// and result are shared across push/pull/force-push/overwrite/publish
// /pull-and-push. The result is the refreshed Worktree so the renderer
// can update its UI without an extra round trip.
export const SyncWorktreePayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
});

export const WorktreeDiffPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
});

export const CommitDiffPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  hash: z.string().min(1),
});

// Branch operations against the project's primary repo (not tied to any
// specific worktree). Used by the Manage Branches page.
export const CreateBranchPayloadSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  base: z.string().min(1).optional(),
});

export const RenameAnyBranchPayloadSchema = z.object({
  projectId: z.string(),
  oldName: z.string().min(1),
  newName: z.string().min(1),
});

export const DeleteBranchPayloadSchema = z.object({
  projectId: z.string(),
  name: z.string().min(1),
  force: z.boolean().default(false),
});

// Filesystem browser used by the Add Project palette.

export const ListDirectoryPayloadSchema = z.object({
  path: z.string().min(1),
});

export const ScanForGitReposPayloadSchema = z.object({
  path: z.string().min(1),
});

export const IsGitRepoPayloadSchema = z.object({
  path: z.string().min(1),
});

export const FsStatPayloadSchema = z.object({
  path: z.string().min(1),
});

// Optional copy for the native folder picker. Defaults to the
// "Add a project" wording for backwards compatibility.
export const PickFolderPayloadSchema = z
  .object({
    title: z.string().min(1).optional(),
    buttonLabel: z.string().min(1).optional(),
  })
  .optional();

// Slim subset of fs.Stats; "exists: false" means the path is missing or
// unreadable. Used by the carry-over row to render a missing warning and
// pick the right icon (file vs folder).
export const FsStatSchema = z.object({
  exists: z.boolean(),
  isDirectory: z.boolean(),
});
export type FsStat = z.infer<typeof FsStatSchema>;

export const FsListEntriesPayloadSchema = z.object({
  path: z.string().min(1),
});

// Filesystem entry as returned by FsListEntries. Includes dotfiles so the
// carry-over picker can surface .env, .vscode, etc., but skips the special
// .git directory since carrying it over makes no sense.
export const FsEntrySchema = z.object({
  name: z.string(),
  isDirectory: z.boolean(),
});
export const FsListingSchema = z.object({
  path: z.string(),
  entries: z.array(FsEntrySchema),
});
export type FsEntry = z.infer<typeof FsEntrySchema>;
export type FsListing = z.infer<typeof FsListingSchema>;

export const DirectoryEntrySchema = z.object({
  name: z.string(),
  isGitRepo: z.boolean(),
});

export const DirectoryListingSchema = z.object({
  path: z.string(),
  entries: z.array(DirectoryEntrySchema),
});

export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;
export type DirectoryListing = z.infer<typeof DirectoryListingSchema>;

// Per-project config. Stored at ~/shigomori[-dev]/projects/<projectId>.json
// and managed by the app, not committed to the user's repo.

export const LauncherCommandSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
});

// Files/folders to carry over from the primary checkout into newly-created
// worktrees. `path` is relative to the project root; gitignored entries are
// the expected source. `symlink` keeps state shared; `copy` snapshots.
export const CarryOverEntrySchema = z.object({
  path: z
    .string()
    .min(1)
    .refine(
      (p) =>
        !p.startsWith("/") &&
        !p.split(/[\\/]/).includes("..") &&
        !p.includes("\0"),
      { message: "Path must stay within the project root" },
    ),
  mode: z.enum(["copy", "symlink"]),
});

// Where shigomori's managed worktrees for this project live on disk.
// - managed-root: ~/shigomori[-dev]/worktrees/<projectName>/<worktreeName>
//   (default; one place for every project's worktrees, easy to nuke)
// - in-project: <projectPath>/.shigomori/worktrees/<worktreeName>
//   (sits inside the primary; lets tools that walk up to a workspace
//   root, like Turbopack, accept symlinked node_modules from carry-over)
// - custom: <customWorktreePath>/<worktreeName>
//   (escape hatch; not recommended -- can collide with other repos and
//   complicates external-vs-managed detection)
export const WorktreeLayoutSchema = z.enum([
  "managed-root",
  "in-project",
  "custom",
]);
export type WorktreeLayout = z.infer<typeof WorktreeLayoutSchema>;

export const ShigomoriConfigSchema = z.object({
  scripts: z
    .object({
      setup: z.string().optional(),
      teardown: z.string().optional(),
    })
    .partial()
    .optional(),
  launchers: z.array(LauncherCommandSchema).optional(),
  portBase: z.number().int().positive().optional(),
  defaultBranch: z.string().min(1),
  // Free-form per-worktree notes, keyed by Worktree.id (the path hash).
  notes: z.record(z.string(), z.string()).optional(),
  carryOver: z.array(CarryOverEntrySchema).optional(),
  worktreeLayout: WorktreeLayoutSchema.optional(),
  // Absolute path; only meaningful when worktreeLayout === "custom".
  customWorktreePath: z.string().optional(),
});

export const ThemeSchema = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof ThemeSchema>;

// Global, per-user config kept in ~/shigomori[-dev]/config.json. Holds
// preferences that span every project: custom launchers the user wants
// everywhere (claude, tmux, an editor command, etc.), and room for future
// settings.
export const GlobalConfigSchema = z.object({
  theme: ThemeSchema.optional(),
  launchers: z.array(LauncherCommandSchema).optional(),
  // When true, deleting a worktree also force-deletes its checked-out
  // local branch (skipped if the branch is the primary's or is in use
  // by another worktree). Off by default; matches git's native
  // `git worktree remove` behavior.
  deleteBranchOnRemove: z.boolean().optional(),
  // When true, adding a project with a package.json seeds its setup
  // script with `<detected-pm> install`. Only fires at project-add
  // time; existing projects are untouched.
  autoPopulateInstall: z.boolean().optional(),
  // When true, projects with a valid port-pool.config.json run
  // `port-pool provision` after setup at create and
  // `port-pool release` before teardown at delete.
  portPool: z.boolean().optional(),
  // When true, GitHub CLI features light up wherever they apply.
  // Activates only when `gh` is on PATH and authenticated. On by
  // default; matches the integration being opt-out rather than opt-in.
  githubCli: z.boolean().optional(),
});

export const GithubCliReadinessSchema = z.object({
  installed: z.boolean(),
  authed: z.boolean(),
});

export const WriteGlobalConfigPayloadSchema = z.object({
  config: GlobalConfigSchema,
});

// Detected apps + custom commands from the per-project config, ready for
// the renderer to display in a single launcher row.

export const DetectedLauncherSchema = z.object({
  kind: z.literal("detected"),
  id: z.string(),
  label: z.string(),
  available: z.boolean(),
});

export const CustomLauncherSchema = z.object({
  kind: z.literal("custom"),
  id: z.string(),
  label: z.string(),
});

export const LauncherEntrySchema = z.discriminatedUnion("kind", [
  DetectedLauncherSchema,
  CustomLauncherSchema,
]);

export const LaunchPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  launcherId: z.string(),
});

export const ReadShigomoriPayloadSchema = z.object({
  projectId: z.string(),
});

export const WriteShigomoriPayloadSchema = z.object({
  projectId: z.string(),
  config: ShigomoriConfigSchema,
});

export const ShellPathPayloadSchema = z.object({
  path: z.string().min(1),
});

export const ShellOpenExternalPayloadSchema = z.object({
  url: z.string().url(),
});

export const RuntimeInfoSchema = z.object({
  shigomoriRoot: z.string().min(1),
  homedir: z.string().min(1),
  isDev: z.boolean(),
});

// In-app updater state. `downloading` covers both "found an update" and
// "still pulling bytes" -- macOS's autoUpdater doesn't expose progress,
// so we collapse them. `ready` carries the version we'll restart into.
export const UpdaterStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }),
  z.object({ kind: z.literal("checking") }),
  z.object({ kind: z.literal("downloading") }),
  z.object({
    kind: z.literal("ready"),
    version: z.string(),
    notes: z.string().optional(),
    // ISO 8601; null when the OS gave us an unparseable date.
    releaseDate: z.string().nullable(),
  }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);
export type UpdaterState = z.infer<typeof UpdaterStateSchema>;

export const SetThemePayloadSchema = z.object({
  theme: ThemeSchema,
});

export const ScriptNameSchema = z.enum([
  "setup",
  "teardown",
  "port-pool-provision",
  "port-pool-release",
]);

export const RunScriptPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  script: ScriptNameSchema,
});

export const PackageManagerSchema = z.enum(["bun", "pnpm", "yarn", "npm"]);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

export const PackageScriptUsageSchema = z.object({
  // Epoch ms of the most recent run; 0 when the script has never been run.
  lastUsed: z.number().int().nonnegative(),
  // Number of runs within the rolling-frequency window (matches the
  // launcher's algorithm). 0 when the script has never been run inside
  // the window.
  recentCount: z.number().int().nonnegative(),
});
export type PackageScriptUsage = z.infer<typeof PackageScriptUsageSchema>;

export const PackageScriptsResultSchema = z.object({
  scripts: z.record(z.string(), z.string()),
  packageManager: PackageManagerSchema,
  usage: z.record(z.string(), PackageScriptUsageSchema),
});
export type PackageScriptsResult = z.infer<typeof PackageScriptsResultSchema>;

export const PackageScriptSortModeSchema = z.enum([
  "manifest",
  "alphabetical",
  "recent",
  "frequent",
]);
export type PackageScriptSortMode = z.infer<typeof PackageScriptSortModeSchema>;

export const ListPackageScriptsPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
});

export const RunPackageScriptPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  scriptName: z.string().min(1),
});

export const GetPackageScriptSortPayloadSchema = z.object({
  projectId: z.string(),
});

export const SetPackageScriptSortPayloadSchema = z.object({
  projectId: z.string(),
  mode: PackageScriptSortModeSchema,
});

export const LaunchToolMenuEntrySchema = z.object({
  id: z.string(),
  label: z.string(),
});

export const SetLaunchToolsEnabledPayloadSchema = z.object({
  enabled: z.boolean(),
  // When enabling, the renderer passes the exact entries it's showing so
  // ⌘1..⌘9 always mirror the visible launcher row. Omit when disabling.
  entries: z.array(LaunchToolMenuEntrySchema).optional(),
});

export type LaunchToolMenuEntry = z.infer<typeof LaunchToolMenuEntrySchema>;

export const CancelScriptPayloadSchema = z.object({
  runId: z.string(),
});

// stdout and stderr are merged into one "data" event so xterm renders
// them in true interleave order (matches how a terminal would show
// them). "error" covers spawn failures; "exit" is the final code
// (null if the process died from a signal or we cancelled).
export const ScriptEventSchema = z.discriminatedUnion("kind", [
  z.object({ runId: z.string(), kind: z.literal("data"), data: z.string() }),
  z.object({
    runId: z.string(),
    kind: z.literal("exit"),
    code: z.number().nullable(),
  }),
  z.object({ runId: z.string(), kind: z.literal("error"), data: z.string() }),
  // Emitted when main initiates a script (lifecycle orchestration);
  // lets the renderer bind runId -> slot before data/exit arrive.
  z.object({
    runId: z.string(),
    kind: z.literal("started"),
    projectId: z.string(),
    worktreeId: z.string(),
    slot: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("setup") }),
      z.object({ kind: z.literal("teardown") }),
      z.object({
        kind: z.literal("portPool"),
        phase: z.enum(["provision", "release"]),
      }),
    ]),
  }),
]);

export const CleanupErrorSchema = z.object({
  phase: z.enum(["teardown", "portPoolRelease"]),
  exitCode: z.number().nullable(),
  runId: z.string(),
});

export type CleanupError = z.infer<typeof CleanupErrorSchema>;

export const DeleteWorktreeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), cleanupError: CleanupErrorSchema }),
]);

export type DeleteWorktreeResult = z.infer<typeof DeleteWorktreeResultSchema>;

export type Project = z.infer<typeof ProjectSchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type CommitSummary = z.infer<typeof CommitSummarySchema>;
export type ShigomoriConfig = z.infer<typeof ShigomoriConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type GithubCliReadiness = z.infer<typeof GithubCliReadinessSchema>;
export type PullRequestState = z.infer<typeof PullRequestStateSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;
export type LauncherCommand = z.infer<typeof LauncherCommandSchema>;
export type CarryOverEntry = z.infer<typeof CarryOverEntrySchema>;
export type CarryOverFailure = z.infer<typeof CarryOverFailureSchema>;
export type CarryOverReport = z.infer<typeof CarryOverReportSchema>;
export type CreateWorktreeResult = z.infer<typeof CreateWorktreeResultSchema>;
export type LauncherEntry = z.infer<typeof LauncherEntrySchema>;
export type DetectedLauncher = z.infer<typeof DetectedLauncherSchema>;
export type CustomLauncher = z.infer<typeof CustomLauncherSchema>;
export type ScriptName = z.infer<typeof ScriptNameSchema>;
export type ScriptEvent = z.infer<typeof ScriptEventSchema>;
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;
