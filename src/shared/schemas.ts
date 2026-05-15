// Zod schemas for IPC validation. Types in shared/types.ts derive from these.
import { z } from "zod";

export const CommitSummarySchema = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
});

// Sentinel returned by `deriveBranch` when a worktree has no branch and
// no detached HEAD we can read. Treated as "not a real branch" by every
// consumer that filters branches for operations (delete, switch, etc.).
export const UNKNOWN_BRANCH = "(unknown)";

export const isRealBranch = (branch: string): boolean =>
  branch !== UNKNOWN_BRANCH;

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
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  changedCount: z.number().int().nonnegative(),
  lastCommit: CommitSummarySchema.nullable(),
  port: z.number().int().positive().optional(),
  // The repo's primary checkout. Shown in the UI for context but never
  // removable — deleting it would mean detaching the project itself.
  isPrimary: z.boolean(),
  // True when the worktree lives outside shigomori's managed worktrees dir
  // (i.e. created manually or by another tool). Primary checkouts are also
  // technically external; the UI tags only non-primary externals.
  isExternal: z.boolean(),
});

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  // Populated by ProjectsList only — `false` means the project's path is
  // missing on disk (deleted/moved/unmounted). Other handlers don't set it.
  pathExists: z.boolean().optional(),
});

export const ProjectsListResultSchema = z.array(ProjectSchema);
export const WorktreesListResultSchema = z.array(WorktreeSchema);

export const AddProjectPayloadSchema = z.object({
  path: z.string(),
});

export const RemoveProjectPayloadSchema = z.object({
  id: z.string(),
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

// Raw output from `git ls-files --others --ignored --exclude-standard
// --directory`: relative paths, with trailing "/" on fully-ignored folders.
// The renderer derives membership by checking exact match or any ancestor
// folder match.
export const IgnoredPathsSchema = z.array(z.string());

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

export const CreateWorktreeResultSchema = z.object({
  worktree: WorktreeSchema,
  carryOver: CarryOverReportSchema,
});

export const DeleteWorktreePayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  force: z.boolean().default(false),
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
  // Free-form per-worktree notes, keyed by Worktree.name (directory basename).
  notes: z.record(z.string(), z.string()).optional(),
  carryOver: z.array(CarryOverEntrySchema).optional(),
});

// Global, per-user config kept in ~/shigomori[-dev]/config.json. Holds
// preferences that span every project: custom launchers the user wants
// everywhere (claude, tmux, an editor command, etc.), and room for future
// settings.
export const GlobalConfigSchema = z.object({
  launchers: z.array(LauncherCommandSchema).optional(),
  // When true, deleting a worktree also force-deletes its checked-out
  // local branch (skipped if the branch is the primary's or is in use
  // by another worktree). Off by default; matches git's native
  // `git worktree remove` behavior.
  deleteBranchOnRemove: z.boolean().optional(),
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

export const RuntimeInfoSchema = z.object({
  shigomoriRoot: z.string().min(1),
  homedir: z.string().min(1),
  isDev: z.boolean(),
});

export const ThemeSchema = z.enum(["light", "dark", "system"]);
export const SetThemePayloadSchema = z.object({
  theme: ThemeSchema,
});
export type Theme = z.infer<typeof ThemeSchema>;

export const ScriptNameSchema = z.enum(["setup", "teardown"]);

export const RunScriptPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  script: ScriptNameSchema,
});

export const PackageManagerSchema = z.enum(["bun", "pnpm", "yarn", "npm"]);
export type PackageManager = z.infer<typeof PackageManagerSchema>;

export const PackageScriptsResultSchema = z.object({
  scripts: z.record(z.string(), z.string()),
  packageManager: PackageManagerSchema,
});
export type PackageScriptsResult = z.infer<typeof PackageScriptsResultSchema>;

export const ListPackageScriptsPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
});

export const RunPackageScriptPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  scriptName: z.string().min(1),
});

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
]);

export type Project = z.infer<typeof ProjectSchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type CommitSummary = z.infer<typeof CommitSummarySchema>;
export type ShigomoriConfig = z.infer<typeof ShigomoriConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
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
