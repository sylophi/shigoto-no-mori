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
  isPrimary: z.boolean().optional(),
  port: z.number().int().positive().optional(),
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
});

// Detected apps + custom commands from shigomori.config.json, ready for the
// renderer to display in a single launcher row.

export const DetectedLauncherSchema = z.object({
  kind: z.literal("detected"),
  id: z.string(),
  label: z.string(),
  icon: z.string(),
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

export const SetPreferredLauncherPayloadSchema = z.object({
  projectId: z.string(),
  launcherId: z.string(),
});

export type Project = z.infer<typeof ProjectSchema>;
export type Worktree = z.infer<typeof WorktreeSchema>;
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;
export type CommitSummary = z.infer<typeof CommitSummarySchema>;
export type ShigotoConfig = z.infer<typeof ShigotoConfigSchema>;
export type LauncherCommand = z.infer<typeof LauncherCommandSchema>;
export type LauncherEntry = z.infer<typeof LauncherEntrySchema>;
export type DetectedLauncher = z.infer<typeof DetectedLauncherSchema>;
export type CustomLauncher = z.infer<typeof CustomLauncherSchema>;
export type ScriptName = z.infer<typeof ScriptNameSchema>;
export type ScriptEvent = z.infer<typeof ScriptEventSchema>;
