import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  CreateWorktreePayloadSchema,
  DeleteWorktreePayloadSchema,
  ListWorktreesPayloadSchema,
  type Project,
  type Worktree,
} from "@shared/schemas";
import { createWorktree, listWorktrees, removeWorktree } from "../git";
import { readKey } from "../store";

const PROJECTS_KEY = "projects";

function findProject(projectId: string): Project | undefined {
  const projects = readKey<Project[]>(PROJECTS_KEY, []);
  return projects.find((p) => p.id === projectId);
}

export function registerWorktreeHandlers(): void {
  ipcMain.handle(
    CHANNELS.WorktreesList,
    async (_event, rawPayload: unknown): Promise<Worktree[]> => {
      const { projectId } = ListWorktreesPayloadSchema.parse(rawPayload);
      const project = findProject(projectId);
      if (!project) throw new Error(`Unknown project: ${projectId}`);
      return listWorktrees(project.id, project.path);
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreesCreate,
    async (_event, rawPayload: unknown): Promise<Worktree> => {
      const { projectId, branchName, base } =
        CreateWorktreePayloadSchema.parse(rawPayload);
      const project = findProject(projectId);
      if (!project) throw new Error(`Unknown project: ${projectId}`);
      await createWorktree(project.path, branchName, base);
      const trees = await listWorktrees(project.id, project.path);
      const created = trees.find((w) => w.branch === branchName);
      if (!created) {
        throw new Error(
          `Worktree was created but did not appear in the list for branch ${branchName}`,
        );
      }
      return created;
    },
  );

  ipcMain.handle(
    CHANNELS.WorktreesDelete,
    async (_event, rawPayload: unknown): Promise<void> => {
      const { projectId, worktreeId, force } =
        DeleteWorktreePayloadSchema.parse(rawPayload);
      const project = findProject(projectId);
      if (!project) throw new Error(`Unknown project: ${projectId}`);
      const trees = await listWorktrees(project.id, project.path);
      const target = trees.find((w) => w.id === worktreeId);
      if (!target) throw new Error(`Unknown worktree: ${worktreeId}`);
      if (target.isPrimary) {
        throw new Error("Cannot delete the project's primary worktree");
      }
      if (target.dirtyCount > 0 && !force) {
        throw new Error(
          `Worktree has ${target.dirtyCount} uncommitted change(s). Pass force=true to remove anyway.`,
        );
      }
      await removeWorktree(project.path, target.path, force);
    },
  );
}
