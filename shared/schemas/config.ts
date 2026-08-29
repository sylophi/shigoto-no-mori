import { z } from "zod";
import { isSafeRelPath } from "../gitPaths";
import { ProjectScopedPayloadSchema } from "./payloads";
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
  path: z.string().min(1).refine(isSafeRelPath, {
    message: "Path must stay within the project root",
  }),
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
// Strict on purpose. It doubles as the shigomori:write IPC input, so a
// key the renderer invents is dropped at the boundary instead of being
// persisted into the user's file. Reads use the Stored variant below.
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
  // When false, the repo's .worktreeinclude file is ignored at worktree
  // creation. Absent = enabled (the integration is opt-out).
  useWorktreeInclude: z.boolean().optional(),
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

// The same document as read from disk, where a newer version may have
// left keys this build doesn't model. Loose so the app doesn't strip
// them out from under the user. They never have to ride back out in a
// write payload: the CLI's `config write` merges into the file rather
// than replacing it, so a key the payload doesn't mention stays put.
export const StoredShigomoriConfigSchema = ShigomoriConfigSchema.loose();

// Snapshot of the repo's .worktreeinclude file (Claude Code convention:
// gitignore-syntax patterns whose gitignored matches are copied into new
// worktrees). Read-only from the app's side; the file belongs to the repo.
export const WorktreeIncludeStatusSchema = z.object({
  fileExists: z.boolean(),
  // Paths the file's patterns currently resolve to (matched AND
  // gitignored), in git's raw shape: fully-ignored directories keep
  // their trailing slash. Matches what creation-time reconciliation
  // sees, so the UI's covered badge and the actual auto-removal agree.
  // Empty when resolution fails.
  matchedPaths: z.array(z.string()),
});
export type WorktreeIncludeStatus = z.infer<typeof WorktreeIncludeStatusSchema>;

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
// Strict for the same reason as ShigomoriConfigSchema: it doubles as
// the globalConfig:write IPC input.
export const GlobalConfigSchema = z.object({
  theme: ThemeSchema.optional(),
  // "Animal Crossing" visual mode. Orthogonal to theme: when on, both
  // the light and dark palettes shift to a bolder, color-blocked,
  // Zen-Maru-Gothic-typeset look. On by default; absent = on, explicit
  // `false` is the opt-out back to the v1 look. Mirrored to
  // localStorage so startup paints without a flash.
  doubutsu: z.boolean().optional(),
  launchers: z.array(LauncherCommandSchema).optional(),
  // Launcher entry ids (`app:cursor`, `web:github`, `custom:<uuid>`) the
  // user has switched off, so they're skipped when building a project's
  // launcher row -- and therefore also absent from the File menu's
  // ⌘1..⌘9, which mirrors the row. Everything is shown by default;
  // absent = nothing hidden. Ids that no longer resolve (an app the user
  // uninstalled, a deleted custom tool) simply never match and are
  // harmless to keep.
  hiddenLaunchers: z.array(z.string()).optional(),
  // When true, the Launch section carries a second row of the worktree's
  // top package.json scripts -- as many as fit on one line, ordered by the
  // project's script sort. On by default; absent = on, explicit `false` is
  // the opt-out.
  launchScripts: z.boolean().optional(),
  // When false, deleting a worktree keeps its checked-out local branch
  // (deletion is skipped anyway if the branch is the primary's or in
  // use by another worktree). ON by default -- unset means delete, in
  // both engines (cli/cmd_config.go and main/lib/nuke.ts).
  deleteBranchOnRemove: z.boolean().optional(),
  // When true, adding a project with a package.json seeds its setup
  // script with `<detected-pm> install`. Only fires at project-add
  // time; existing projects are untouched.
  autoPopulateInstall: z.boolean().optional(),
  // When true, projects with a valid port-pool.config.json run
  // `port-pool provision` after setup at create and
  // `port-pool release` before teardown at delete.
  portPool: z.boolean().optional(),
  // When true, repos registered in terrier (github.com/sylophi/terrier)
  // are listed as projects alongside the registry's own. Terrier-sourced
  // projects can't be removed here, only `terrier rm` unregisters them. A
  // path registered in both is an ordinary removable project, and
  // removing its registry entry demotes it back to terrier-sourced. Off by
  // default, and only active while `terrier` is on PATH at a version
  // this build understands (main/lib/terrier.ts, cli/terrier.go).
  terrier: z.boolean().optional(),
  // When true, GitHub CLI features light up wherever they apply.
  // Activates only when `gh` is on PATH and authenticated. On by
  // default; matches the integration being opt-out rather than opt-in.
  githubCli: z.boolean().optional(),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

// Read-side counterpart, loose like StoredShigomoriConfigSchema.
export const StoredGlobalConfigSchema = GlobalConfigSchema.loose();

export const WriteGlobalConfigPayloadSchema = z.object({
  config: GlobalConfigSchema,
});

export const WriteShigomoriPayloadSchema = ProjectScopedPayloadSchema.extend({
  config: ShigomoriConfigSchema,
});

// Per-worktree data IPC payloads construct filesystem paths directly from
// `worktreeId` (unlike other handlers, which route the id through git's
// worktree list first). Constrain it to the exact 12-hex shape that
// `worktreeIdFromPath` produces so a malformed id can't escape the
// projects/<id>/worktrees/ directory.
const WorktreeIdSchema = z.string().regex(/^[0-9a-f]{12}$/);

export const ReadWorktreeDataPayloadSchema = ProjectScopedPayloadSchema.extend({
  worktreeId: WorktreeIdSchema,
});

export const WriteWorktreeDataPayloadSchema =
  ReadWorktreeDataPayloadSchema.extend({
    data: ShigomoriWorktreeDataSchema,
  });

export const SetThemePayloadSchema = z.object({
  theme: ThemeSchema,
});
