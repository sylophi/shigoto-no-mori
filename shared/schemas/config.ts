import { z } from "zod";
import { MergeMethodSchema } from "./pullRequest";

export const ThemeSchema = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof ThemeSchema>;

export const LauncherCommandSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
});
export type LauncherCommand = z.infer<typeof LauncherCommandSchema>;

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
export type CarryOverEntry = z.infer<typeof CarryOverEntrySchema>;

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

// Per-project config. Stored at ~/shigomori[-dev]/projects/<projectId>.json
// and managed by the app, not committed to the user's repo.
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
  carryOver: z.array(CarryOverEntrySchema).optional(),
  worktreeLayout: WorktreeLayoutSchema.optional(),
  // Absolute path; only meaningful when worktreeLayout === "custom".
  customWorktreePath: z.string().optional(),
  // Last merge method picked for this project's PRs. Drives the split-
  // button's primary action so each repo remembers its house style.
  // Falls back to whatever the repo allows when the saved value is
  // disabled at GitHub.
  lastMergeMethod: MergeMethodSchema.optional(),
});
export type ShigomoriConfig = z.infer<typeof ShigomoriConfigSchema>;

// Per-worktree persistent data. Only kept for shigomori-managed worktrees;
// external worktrees deliberately have no on-disk state.
export const ShigomoriWorktreeDataSchema = z.object({
  notes: z.string().optional(),
});
export type ShigomoriWorktreeData = z.infer<typeof ShigomoriWorktreeDataSchema>;

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
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const WriteGlobalConfigPayloadSchema = z.object({
  config: GlobalConfigSchema,
});

export const ReadShigomoriPayloadSchema = z.object({
  projectId: z.string(),
});

export const WriteShigomoriPayloadSchema = z.object({
  projectId: z.string(),
  config: ShigomoriConfigSchema,
});

// Per-worktree data IPC payloads construct filesystem paths directly from
// `worktreeId` (unlike other handlers, which route the id through git's
// worktree list first). Constrain it to the exact 12-hex shape that
// `worktreeIdFromPath` produces so a malformed id can't escape the
// projects/<id>/worktrees/ directory.
const WorktreeIdSchema = z.string().regex(/^[0-9a-f]{12}$/);

export const ReadWorktreeDataPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: WorktreeIdSchema,
});

export const WriteWorktreeDataPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: WorktreeIdSchema,
  data: ShigomoriWorktreeDataSchema,
});

export const SetThemePayloadSchema = z.object({
  theme: ThemeSchema,
});
