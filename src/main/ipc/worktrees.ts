import { ipcMain } from "electron";
import { CHANNELS } from "@shared/channels";
import {
  ListWorktreesPayloadSchema,
  type Project,
  type Worktree,
} from "@shared/schemas";
import { listWorktrees } from "../git";
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
}
