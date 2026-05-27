import { randomUUID } from "node:crypto";
import { reorderProjects } from "@shared/reorder";
import type { Project, ShigomoriConfig } from "@shared/schemas";
import type { Handlers } from "@shared/ipc/types";
import { projectsContract } from "@shared/modules/projects/contract";
import { readGlobalConfig } from "../../config/global";
import {
  deleteProjectState,
  readShigomoriConfig,
  writeShigomoriConfig,
} from "../../config/project";
import { writeKey } from "../../config/store";
import {
  deriveProjectName,
  isGitRepo,
  listBranches,
  listIgnoredPaths,
  pickAvailableWorktreeName,
  resolveDefaultBranch,
} from "../../git";
import {
  findProjectOrThrow,
  listProjectsWithStatus,
  loadProjects,
  PROJECTS_KEY,
} from "../../projects";
import { forgetProjectIcon, readProjectIcon } from "../../projects/icon";
import { readPackageScripts } from "../../scripts/packageScripts";
import { expandHome } from "../../util/paths";

function saveProjects(projects: Project[]): void {
  writeKey<Project[]>(PROJECTS_KEY, projects);
}

export const projectsHandlers: Handlers<typeof projectsContract> = {
  list: () => listProjectsWithStatus(),

  add: async ({ path: rawPath }) => {
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

    // Best-effort: seed a minimal config so downstream code always has a
    // stable file to work against. Bare repos and unborn HEADs land in the
    // catch and stay null until first Save.
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
      // Intentionally swallowed.
    }

    return project;
  },

  remove: async ({ id }) => {
    const projects = loadProjects();
    const removed = projects.find((p) => p.id === id);
    saveProjects(projects.filter((p) => p.id !== id));
    // Drop the icon-cache entry and on-disk state so neither leaks across
    // re-adds of the same path.
    if (removed) await forgetProjectIcon(removed.path);
    await deleteProjectState(id);
  },

  reorder: ({ draggedId, targetId, position }) => {
    const projects = loadProjects();
    saveProjects(reorderProjects(projects, draggedId, targetId, position));
  },

  defaultBranch: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    const config = await readShigomoriConfig(project.id);
    return resolveDefaultBranch(project.path, config?.defaultBranch);
  },

  listBranches: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return listBranches(project.path);
  },

  pickWorktreeName: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return pickAvailableWorktreeName(project.id, project.path);
  },

  listIgnoredPaths: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return listIgnoredPaths(project.path);
  },

  icon: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return readProjectIcon(project.path);
  },
};
