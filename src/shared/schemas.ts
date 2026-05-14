// Zod schemas for IPC validation. Types in shared/types.ts derive from these.
import { z } from "zod";

export const WorktreeStatusSchema = z.enum([
  "clean",
  "dirty",
  "ahead",
  "behind",
  "diverged",
]);

export const CommitSummarySchema = z.object({
  hash: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
});

export const WorktreeSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  branch: z.string(),
  path: z.string(),
  status: WorktreeStatusSchema,
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  dirtyCount: z.number().int().nonnegative(),
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

export const BranchListSchema = z.object({
  local: z.array(z.string()),
  remote: z.array(z.string()),
});
export type BranchList = z.infer<typeof BranchListSchema>;

export const CreateWorktreePayloadSchema = z.object({
  projectId: z.string(),
  branchName: z.string().min(1),
  base: z.string().optional(),
});

export const DeleteWorktreePayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  force: z.boolean().default(false),
});

// Filesystem browser used by the Add Project palette.

export const ListDirectoryPayloadSchema = z.object({
  path: z.string().min(1),
});

export const ScanForGitReposPayloadSchema = z.object({
  path: z.string().min(1),
});

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

// shigomori.config.json — per-project config committed to the repo.

export const LauncherCommandSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.string().min(1),
});

export const ShigotoConfigSchema = z.object({
  scripts: z
    .object({
      setup: z.string().optional(),
      run: z.string().optional(),
      teardown: z.string().optional(),
    })
    .partial()
    .optional(),
  launchers: z.array(LauncherCommandSchema).optional(),
  portBase: z.number().int().positive().optional(),
  defaultBranch: z.string().min(1),
});

// Global, per-user config kept in ~/shigomori/config.json. Holds preferences
// that span every project: custom launchers the user wants everywhere
// (claude, tmux, an editor command, etc.), and room for future settings.
export const GlobalConfigSchema = z.object({
  launchers: z.array(LauncherCommandSchema).optional(),
});

export const WriteGlobalConfigPayloadSchema = z.object({
  config: GlobalConfigSchema,
});

// Detected apps + custom commands from shigomori.config.json, ready for the
// renderer to display in a single launcher row.

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

export const ReadShigotoPayloadSchema = z.object({
  projectId: z.string(),
});

export const WriteShigotoPayloadSchema = z.object({
  projectId: z.string(),
  config: ShigotoConfigSchema,
});

export const ShellPathPayloadSchema = z.object({
  path: z.string().min(1),
});

export const ThemeSchema = z.enum(["light", "dark", "system"]);
export const SetThemePayloadSchema = z.object({
  theme: ThemeSchema,
});
export type Theme = z.infer<typeof ThemeSchema>;

export const ScriptNameSchema = z.enum(["setup", "run", "teardown"]);

export const RunScriptPayloadSchema = z.object({
  projectId: z.string(),
  worktreeId: z.string(),
  script: ScriptNameSchema,
});

export const CancelScriptPayloadSchema = z.object({
  runId: z.string(),
});

export const ScriptEventSchema = z.discriminatedUnion("kind", [
  z.object({ runId: z.string(), kind: z.literal("stdout"), data: z.string() }),
  z.object({ runId: z.string(), kind: z.literal("stderr"), data: z.string() }),
  z.object({
    runId: z.string(),
    kind: z.literal("exit"),
    code: z.number().nullable(),
  }),
  z.object({ runId: z.string(), kind: z.literal("error"), data: z.string() }),
]);

export type Project = z.infer<typeof ProjectSchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;
export type CommitSummary = z.infer<typeof CommitSummarySchema>;
export type ShigotoConfig = z.infer<typeof ShigotoConfigSchema>;
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
export type LauncherCommand = z.infer<typeof LauncherCommandSchema>;
export type LauncherEntry = z.infer<typeof LauncherEntrySchema>;
export type DetectedLauncher = z.infer<typeof DetectedLauncherSchema>;
export type CustomLauncher = z.infer<typeof CustomLauncherSchema>;
export type ScriptName = z.infer<typeof ScriptNameSchema>;
export type ScriptEvent = z.infer<typeof ScriptEventSchema>;
