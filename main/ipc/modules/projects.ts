import { reorderProjects } from "@shared/reorder";
import type { Project } from "@shared/schemas";
import type { Handlers } from "@shared/ipc/types";
import { projectsContract } from "@shared/ipc/modules/projects";
import { readShigomoriConfig } from "../../lib/config/project";
import { PROJECTS_KEY, registryStore } from "../../lib/config/store";
import { listBranches, listIgnoredPaths } from "../../lib/git/branches";
import { isGitRepo } from "../../lib/git/core";
import { resolveDefaultBranch } from "../../lib/git/remotes";
import { pickAvailableWorktreeName } from "../../lib/git/worktrees";
import {
  findProjectOrThrow,
  listProjectsWithStatus,
  loadProjects,
} from "../../lib/projects";
import { forgetProjectIcon, readProjectIcon } from "../../lib/projects/icon";
import {
  dropCollapsedProject,
  readCollapsedProjects,
  toggleCollapsedProject,
} from "../../lib/projects/collapsed";
import {
  readSidebarView,
  writeSidebarView,
} from "../../lib/projects/sidebarView";
import { readProjectSort, writeProjectSort } from "../../lib/projects/usage";
import { readWorktreeIncludeStatus } from "../../lib/worktrees/worktreeInclude";
import {
  clearProjectDeleteInflight,
  killScriptsForProject,
  markProjectDeleteInflight,
} from "../../lib/scripts";
import { terrierListingsSnapshot, terrierProjectId } from "../../lib/terrier";
import { expandHome } from "../../lib/util/paths";
import { projectsAddViaCli, projectsRemoveViaCli } from "../cliDelegate";

export const projectsHandlers: Handlers<typeof projectsContract> = {
  list: () => listProjectsWithStatus(),

  add: async ({ path: rawPath }) => {
    const path = expandHome(rawPath);

    if (!(await isGitRepo(path))) {
      throw new Error(`${path} is not a git repository`);
    }

    // Same engine as `sm projects add`: registration and the config
    // seed run in the CLI.
    return projectsAddViaCli(path);
  },

  remove: async ({ id }) => {
    const removed = loadProjects().find((p) => p.id === id);
    if (!removed) return;
    if (removed.source === "terrier") {
      // The UI disables removal for terrier-sourced projects; this
      // backstops a stale renderer list.
      throw new Error(
        `${removed.name} is registered via terrier — unregister it with \`terrier rm\`, or turn the terrier integration off in Settings.`,
      );
    }
    // A path terrier also registers doesn't leave the sidebar: dropping
    // the registry entry just demotes it to a terrier-sourced project.
    // When the id carries over (registration minted the deterministic
    // terrier id), nothing is actually going away — skip the script
    // reaping and the app-side cleanup, and let the CLI skip the state
    // dir for the same reason.
    const persists =
      terrierListingsSnapshot().some((t) => t.path === removed.path) &&
      terrierProjectId(removed.path) === id;
    if (persists) {
      await projectsRemoveViaCli(id);
      return;
    }
    // Reap scripts running in this project's worktrees before dropping
    // the registry entry: once the id is gone the renderer has no UI
    // left to stop them, and the per-worktree delete path (which would
    // normally kill them) can't be reached for an unknown project.
    // The inflight mark blocks a renderer script run from spawning into
    // the project during the kill window -- the kill snapshots running
    // scripts once, so a spawn slipping in after that would outlive the
    // removal as an unstoppable orphan.
    markProjectDeleteInflight(id);
    try {
      await killScriptsForProject(id);
      // Registry drop and per-project state deletion run in the CLI
      // (same engine as `sm projects remove`).
      await projectsRemoveViaCli(id);
    } finally {
      clearProjectDeleteInflight(id);
    }
    // Drop the icon-cache entry and collapsed pref so neither leaks
    // across re-adds of the same path. The CLI already deleted the
    // per-project state dir.
    await forgetProjectIcon(removed.path);
    dropCollapsedProject(id);
  },

  reorder: ({ draggedId, targetId, position }) => {
    // updateKey so the current list is read under the cross-process lock:
    // the CLI writes this key too (sm projects add), and deriving the new
    // list from a read taken outside the lock would clobber a concurrent
    // CLI write.
    registryStore.updateKey<Project[]>(PROJECTS_KEY, [], (current) =>
      reorderProjects(current, draggedId, targetId, position),
    );
  },

  getSort: () => readProjectSort(),

  setSort: ({ mode }) => writeProjectSort(mode),

  getSidebarView: () => readSidebarView(),

  setSidebarView: ({ view }) => writeSidebarView(view),

  getCollapsed: () => readCollapsedProjects(),

  toggleCollapsed: ({ projectId }) => toggleCollapsedProject(projectId),

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
