import { pickCloneUrl, repoNameFromUrl } from "@shared/cloneUrl";
import { errorMessageOf } from "@shared/errors";
import { reorderProjects } from "@shared/reorder";
import type { Handlers } from "@shared/ipc/types";
import { projectsContract } from "@shared/ipc/modules/projects";
import { listBranches } from "@host/lib/git/branches";
import { cloneRepo } from "@host/lib/git/clone";
import { isGitRepo } from "@host/lib/git/core";
import { listRemoteEntries } from "@host/lib/git/remotes";
import {
  findProjectOrThrow,
  listProjects,
  listProjectsWithStatus,
  primaryRefOf,
  refreshProjects,
  registerProject,
} from "@host/lib/projects";
import {
  listCarryOverCandidates,
  statCarryOverPaths,
} from "@host/lib/worktrees/carryOver";
import { readWorktreeIncludeStatus } from "@host/lib/worktrees/worktreeInclude";
import {
  clearProjectDeleteInflight,
  killScriptsForProject,
  markProjectDeleteInflight,
} from "@host/lib/scripts";
import { expandHome } from "@host/lib/util/paths";
import {
  projectIconViaCli,
  projectsRemoveViaCli,
  reorderProjectsViaCli,
  worktreeDestinationViaCli,
} from "../cliDelegate";

export const projectsHandlers: Handlers<typeof projectsContract> = {
  list: () => listProjectsWithStatus(),

  add: async ({ path: rawPath }) => {
    const path = expandHome(rawPath);

    if (!(await isGitRepo(path))) {
      throw new Error(`${path} is not a git repository`);
    }

    // Same engine as `sm projects add`: registration and the config
    // seed run in the CLI.
    return registerProject(path);
  },

  clone: async ({ url, parentDir, name }) => {
    const folder = name ?? repoNameFromUrl(url);
    // The payload schema has held the URL to a remote already. Not
    // echoed: it may carry a token.
    if (folder === null) throw new Error("Not a git remote URL");
    const path = await cloneRepo(url, expandHome(parentDir), folder);
    // The checkout stays if registering fails, so the error says where
    // it is: a retry would only find the folder taken.
    return registerProject(path).catch((error: unknown) => {
      throw new Error(
        `Cloned into ${path}, but couldn't add it as a project: ${errorMessageOf(error)}`,
      );
    });
  },

  remove: async ({ id }) => {
    const removed = (await listProjects()).find((p) => p.id === id);
    if (!removed) return;
    if (removed.source === "terrier") {
      // The UI disables removal for terrier-sourced projects, so this
      // only backstops a stale renderer list.
      throw new Error(
        `${removed.name} is registered via terrier. Unregister it with \`terrier rm\`, or turn the terrier integration off in Settings.`,
      );
    }
    // The inflight mark blocks a renderer script run from spawning into
    // the project for the whole removal, so the reap below snapshots a
    // set nothing can add to.
    markProjectDeleteInflight(id);
    try {
      // Registry drop and per-project state deletion (the icon cache
      // entry included) run in the CLI, same engine as `sm projects
      // remove`.
      await projectsRemoveViaCli(id);
      // A path terrier also registers doesn't leave the sidebar:
      // dropping the registry entry just demotes it to a terrier-sourced
      // project, and when the id carries over (registration minted the
      // deterministic terrier id) nothing is actually going away. Read
      // from the list the removal left behind, so the answer is the
      // CLI's own, not a guess at its rule.
      const survived = (await refreshProjects()).some((p) => p.id === id);
      // Reap scripts running in this project's worktrees: once the id
      // is gone the renderer has no UI left to stop them, and the
      // per-worktree delete path (which would normally kill them) can't
      // be reached for an unknown project.
      if (!survived) await killScriptsForProject(id);
    } finally {
      clearProjectDeleteInflight(id);
    }
  },

  // Under the CLI's registry lock, which also keeps a project added
  // meanwhile (it lands last). The terrier-only projects have no
  // registry entry to move, as before.
  reorder: async ({ draggedId, targetId, position }) => {
    const registered = (await listProjects()).filter(
      (p) => p.source !== "terrier",
    );
    const next = reorderProjects(registered, draggedId, targetId, position);
    if (next === registered) return;
    await reorderProjectsViaCli(next.map((p) => p.id));
    await refreshProjects();
  },

  // The primary ref every row is measured against, which the CLI
  // resolves once per project (the configured override first).
  defaultBranch: async ({ projectId }) =>
    primaryRefOf(await findProjectOrThrow(projectId)),

  cloneUrl: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    return pickCloneUrl(await listRemoteEntries(project.path));
  },

  listBranches: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    return listBranches(project.path);
  },

  // The name the CLI would pick for a new worktree right now.
  pickWorktreeName: async ({ projectId }) =>
    (await worktreeDestinationViaCli(projectId)).name,

  worktreeIncludeStatus: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    return readWorktreeIncludeStatus(project.id, project.path);
  },

  carryOverListing: async ({ projectId, relative, ruleIgnored }) => {
    const project = await findProjectOrThrow(projectId);
    return listCarryOverCandidates(project.id, project.path, relative, {
      ruleIgnored,
    });
  },

  carryOverStats: async ({ projectId, paths }) => {
    const project = await findProjectOrThrow(projectId);
    return statCarryOverPaths(project.id, project.path, paths);
  },

  // The CLI resolves icons through its shared cache (cli/icon.go).
  icon: ({ projectId }) => projectIconViaCli(projectId),
};
