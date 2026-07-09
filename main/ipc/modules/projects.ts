import { randomUUID } from "node:crypto";
import { reorderProjects } from "@shared/reorder";
import type { Project, ShigomoriConfig } from "@shared/schemas";
import type { Handlers } from "@shared/ipc/types";
import { projectsContract } from "@shared/ipc/modules/projects";
import { readGlobalConfig } from "../../lib/config/global";
import {
  deleteProjectState,
  readShigomoriConfig,
  writeShigomoriConfig,
} from "../../lib/config/project";
import { writeKey } from "../../lib/config/store";
import { listBranches, listIgnoredPaths } from "../../lib/git/branches";
import { isGitRepo } from "../../lib/git/core";
import { resolveDefaultBranch } from "../../lib/git/remotes";
import {
  deriveProjectName,
  pickAvailableWorktreeName,
} from "../../lib/git/worktrees";
import {
  findProjectOrThrow,
  listProjectsWithStatus,
  loadProjects,
  PROJECTS_KEY,
} from "../../lib/projects";
import { forgetProjectIcon, readProjectIcon } from "../../lib/projects/icon";
import { readProjectSort, writeProjectSort } from "../../lib/projects/usage";
import { readWorktreeIncludeStatus } from "../../lib/worktrees/worktreeInclude";
import { readPackageScripts } from "../../lib/scripts/packageScripts";
import { comparablePath, expandHome } from "../../lib/util/paths";

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
    // comparablePath: the same directory can arrive as C:/x, C:\x, or
    // different casing on Windows; one project row per directory.
    if (existing.some((p) => comparablePath(p.path) === comparablePath(path))) {
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
    // re-adds of the same path. State deletion is a recursive rm keyed
    // on the id, so only run it for an id that matched a real project.
    if (removed) {
      await forgetProjectIcon(removed.path);
      await deleteProjectState(id);
    }
  },

  reorder: ({ draggedId, targetId, position }) => {
    const projects = loadProjects();
    saveProjects(reorderProjects(projects, draggedId, targetId, position));
  },

  getSort: () => readProjectSort(),

  setSort: ({ mode }) => writeProjectSort(mode),

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

  worktreeIncludeStatus: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return readWorktreeIncludeStatus(project.path);
  },

  icon: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    return readProjectIcon(project.path);
  },
};
