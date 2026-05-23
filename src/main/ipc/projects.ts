import { dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { CHANNELS } from "@shared/channels";
import {
  AddProjectPayloadSchema,
  type BranchList,
  ListIgnoredPathsPayloadSchema,
  PickFolderPayloadSchema,
  PickWorktreeNamePayloadSchema,
  type Project,
  type ProjectIcon,
  ProjectIconPayloadSchema,
  ProjectsDefaultBranchPayloadSchema,
  ProjectsListBranchesPayloadSchema,
  type ShigomoriConfig,
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
import { readGlobalConfig } from "../globalConfig";
import { readPackageScripts } from "../packageScripts";
import { expandHome } from "../paths";
import {
  findProjectOrThrow,
  listProjectsWithStatus,
  loadProjects,
  PROJECTS_KEY,
} from "../projects";
import { forgetProjectIcon, readProjectIcon } from "../projectIcon";
import {
  deleteProjectState,
  readShigomoriConfig,
  writeShigomoriConfig,
} from "../shigomori";
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

    // Seed a minimal config so downstream code (and the user) always has
    // a stable file to work against. If the repo has no resolvable
    // default branch yet (bare repo, unborn HEAD), skip seeding — the
    // lazy path still works.
    try {
      const defaultBranch = await resolveDefaultBranch(path);
      const seeded: ShigomoriConfig = { defaultBranch };
      const globalConfig = await readGlobalConfig();
      if (globalConfig.autoPopulateInstall) {
        const pkg = await readPackageScripts(path);
        if (pkg) seeded.scripts = { setup: `${pkg.packageManager} install` };
      }
      await writeShigomoriConfig(project.id, seeded);
    } catch {
      // Intentionally swallowed; config stays null until first Save.
    }

    return project;
  });

  ipcMain.handle(
    CHANNELS.ProjectsRemove,
    async (_event, rawPayload: unknown) => {
      const { id } = RemoveProjectPayloadSchema.parse(rawPayload);
      const projects = loadProjects();
      const removed = projects.find((p) => p.id === id);
      saveProjects(projects.filter((p) => p.id !== id));
      // Drop the project's icon-cache entry so the cache doesn't grow
      // unbounded as projects come and go.
      if (removed) await forgetProjectIcon(removed.path);
      // Same idea for the project's on-disk state directory (project.json
      // + per-worktree files). Best effort -- a stray dir won't break
      // anything, but we'd rather not leak it across re-adds.
      await deleteProjectState(id);
    },
  );

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

  ipcMain.handle(
    CHANNELS.ProjectsIcon,
    async (_event, rawPayload: unknown): Promise<ProjectIcon | null> => {
      const { projectId } = ProjectIconPayloadSchema.parse(rawPayload);
      const project = findProjectOrThrow(projectId);
      return readProjectIcon(project.path);
    },
  );

  ipcMain.handle(
    CHANNELS.DialogPickFolder,
    async (_event, rawPayload: unknown) => {
      const opts = PickFolderPayloadSchema.parse(rawPayload);
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
        title: opts?.title ?? "Add a project",
        buttonLabel: opts?.buttonLabel ?? "Add project",
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    },
  );
}
