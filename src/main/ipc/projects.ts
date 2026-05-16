import { dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { CHANNELS } from "@shared/channels";
import {
  AddProjectPayloadSchema,
  type BranchList,
  ListIgnoredPathsPayloadSchema,
  PickWorktreeNamePayloadSchema,
  type Project,
  ProjectsDefaultBranchPayloadSchema,
  ProjectsListBranchesPayloadSchema,
  ReorderProjectsPayloadSchema,
  RemoveProjectPayloadSchema,
} from "@shared/schemas";
import {
  deriveProjectName,
  isGitRepo,
  listBranches,
  listIgnoredPaths,
  pickAvailableWorktreeName,
  resolveDefaultBranch,
} from "../git";
import { expandHome } from "../paths";
import {
  findProjectOrThrow,
  listProjectsWithStatus,
  loadProjects,
  PROJECTS_KEY,
} from "../projects";
import { readShigomoriConfig } from "../shigomori";
import { writeKey } from "../store";

function saveProjects(projects: Project[]): void {
  writeKey<Project[]>(PROJECTS_KEY, projects);
}

function reorderProjects(
  projects: Project[],
  draggedId: string,
  targetId: string,
  position: "before" | "after",
): Project[] {
  if (draggedId === targetId) return projects;

  const draggedIndex = projects.findIndex((p) => p.id === draggedId);
  if (draggedIndex < 0) return projects;

  const next = [...projects];
  const [dragged] = next.splice(draggedIndex, 1);
  if (!dragged) return projects;

  const targetIndex = next.findIndex((p) => p.id === targetId);
  if (targetIndex < 0) return projects;

  const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
  next.splice(insertIndex, 0, dragged);
  return next;
}

export function registerProjectHandlers(): void {
  ipcMain.handle(CHANNELS.ProjectsList, () => listProjectsWithStatus());

  ipcMain.handle(CHANNELS.ProjectsAdd, async (_event, rawPayload: unknown) => {
    const { path: rawPath } = AddProjectPayloadSchema.parse(rawPayload);
    const path = expandHome(rawPath);

    if (!(await isGitRepo(path))) {
      throw new Error(`${path} is not a git repository`);
    }

    const existing = loadProjects();
    if (existing.some((p) => p.path === path)) {
      throw new Error(`Project already added: ${path}`);
    }

    const project: Project = {
      id: randomUUID(),
      name: deriveProjectName(path),
      path,
    };

    saveProjects([...existing, project]);
    return project;
  });

  ipcMain.handle(CHANNELS.ProjectsRemove, (_event, rawPayload: unknown) => {
    const { id } = RemoveProjectPayloadSchema.parse(rawPayload);
    saveProjects(loadProjects().filter((p) => p.id !== id));
  });

  ipcMain.handle(CHANNELS.ProjectsReorder, (_event, rawPayload: unknown) => {
    const { draggedId, targetId, position } =
      ReorderProjectsPayloadSchema.parse(rawPayload);
    const projects = loadProjects();
    saveProjects(reorderProjects(projects, draggedId, targetId, position));
  });

  ipcMain.handle(
    CHANNELS.ProjectsDefaultBranch,
    async (_event, rawPayload: unknown): Promise<string> => {
      const { projectId } =
        ProjectsDefaultBranchPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      const config = await readShigomoriConfig(project.id);
      return resolveDefaultBranch(project.path, config?.defaultBranch);
    },
  );

  ipcMain.handle(
    CHANNELS.ProjectsListBranches,
    async (_event, rawPayload: unknown): Promise<BranchList> => {
      const { projectId } = ProjectsListBranchesPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return listBranches(project.path);
    },
  );

  ipcMain.handle(
    CHANNELS.ProjectsPickWorktreeName,
    async (_event, rawPayload: unknown): Promise<string> => {
      const { projectId } = PickWorktreeNamePayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return pickAvailableWorktreeName(project.id, project.path);
    },
  );

  ipcMain.handle(
    CHANNELS.ProjectsListIgnoredPaths,
    async (_event, rawPayload: unknown): Promise<string[]> => {
      const { projectId } = ListIgnoredPathsPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return listIgnoredPaths(project.path);
    },
  );

  ipcMain.handle(CHANNELS.DialogPickFolder, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Add a project",
      buttonLabel: "Add project",
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });
}
