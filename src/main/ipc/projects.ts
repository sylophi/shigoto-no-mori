import { dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { CHANNELS } from "@shared/channels";
import {
  AddProjectPayloadSchema,
  type Project,
  ProjectSchema,
  RemoveProjectPayloadSchema,
} from "@shared/schemas";
import { deriveProjectName, isGitRepo } from "../git";
import { readKey, writeKey } from "../store";

const STORE_KEY = "projects";

function loadProjects(): Project[] {
  const raw = readKey<Project[]>(STORE_KEY, []);
  return raw
    .map((p) => ProjectSchema.safeParse(p))
    .filter((r): r is Extract<typeof r, { success: true }> => r.success)
    .map((r) => r.data);
}

function saveProjects(projects: Project[]): void {
  writeKey<Project[]>(STORE_KEY, projects);
}

export function registerProjectHandlers(): void {
  ipcMain.handle(CHANNELS.ProjectsList, () => loadProjects());

  ipcMain.handle(CHANNELS.ProjectsAdd, async (_event, rawPayload: unknown) => {
    const { path } = AddProjectPayloadSchema.parse(rawPayload);

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
