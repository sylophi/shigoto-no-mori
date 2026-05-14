import { dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { CHANNELS } from "@shared/channels";
import {
  AddProjectPayloadSchema,
  type BranchList,
  PickWorktreeNamePayloadSchema,
  type Project,
  ProjectsDefaultBranchPayloadSchema,
  ProjectsListBranchesPayloadSchema,
  RemoveProjectPayloadSchema,
} from "@shared/schemas";
import {
  deriveProjectName,
  isGitRepo,
  listBranches,
  pickAvailableWorktreeName,
  resolveDefaultBranch,
} from "../git";
import { expandHome } from "../paths";
import { findProjectOrThrow, loadProjects } from "../projects";
import { readShigotoConfig } from "../shigoto";
import { writeKey } from "../store";

const STORE_KEY = "projects";

function saveProjects(projects: Project[]): void {
  writeKey<Project[]>(STORE_KEY, projects);
}

export function registerProjectHandlers(): void {
  ipcMain.handle(CHANNELS.ProjectsList, () => loadProjects());

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

  ipcMain.handle(
    CHANNELS.ProjectsDefaultBranch,
    async (_event, rawPayload: unknown): Promise<string> => {
      const { projectId } =
        ProjectsDefaultBranchPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      const config = await readShigotoConfig(project.id);
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
