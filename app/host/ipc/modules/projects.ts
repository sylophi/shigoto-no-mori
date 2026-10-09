import { cloneFolderName, pickCloneUrl } from "@shared/cloneUrl";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { reorderProjects } from "@shared/reorder";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Views from "@host/lib/views";
import type { Project } from "@shigomori/contracts/schemas";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { listBranches } from "@host/lib/git/branches";
import { cloneRepo } from "@host/lib/git/clone";
import { isGitRepo } from "@host/lib/git/core";
import { createRepo } from "@host/lib/git/init";
import { listRemoteEntries } from "@host/lib/git/remotes";
import {
  findProjectOrThrow,
  listProjects,
  listProjectsWithStatus,
  loadProjects,
  primaryRefOf,
  refreshProjects,
  registerProject,
  relocateProject,
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
import { terrierAdd } from "@host/lib/terrier";
import { expandHome } from "@host/lib/util/paths";
import {
  projectIcon,
  removeProject,
  storeProjectOrder,
  worktreeDestination,
} from "@host/lib/engineCalls";

// Moves run one at a time: each writes the whole order, so a second
// drag computed before the first's refresh landed would put the first
// one's project back.
let reorderChain: Promise<void> = Promise.resolve();

// Registers a checkout the app just made (a clone, a new repository).
// The checkout stays if registering fails, so the error says where it
// is: a retry would only find the folder taken. Terrier first, for
// add's reason.
async function registerNewCheckout(
  path: string,
  terrier: boolean | undefined,
  made: string,
): Promise<Project> {
  try {
    if (terrier) await terrierAdd(path);
    return await registerProject(path);
  } catch (error) {
    throw new Error(
      `${made} ${path}, but couldn't add it as a project: ${errorMessageOf(error)}`,
      { cause: error },
    );
  }
}

export const projectsViews: ViewHandlers<
  typeof projectsContract,
  Views.Services
> = {
  // The usage log orders the list; terrier's identities and a missing
  // folder are not the store's, and show on the next write.
  watch: () =>
    Views.view(
      listProjectsWithStatus,
      Views.wrote("projects", "project_order", "project_config", "usage"),
    ),
};

export const projectsHandlers: Handlers<typeof projectsContract> = {
  list: () => listProjectsWithStatus(),

  add: async ({ path: rawPath, terrier }) => {
    const path = expandHome(rawPath);

    if (!(await isGitRepo(path))) {
      throw new Error(`${path} is not a git repository`);
    }

    // Into terrier first, so registering mints the id terrier's listing
    // of the repo carries (Projects.add in the engine):
    // removing the project here later leaves it under the same id, its
    // per-project state intact.
    if (terrier) await terrierAdd(path);
    // Same engine as `sm projects add`: registration and the config
    // seed run in the CLI.
    return registerProject(path);
  },

  clone: async ({ url, parentDir, name, terrier }) => {
    const folder = name ?? cloneFolderName(url);
    // The payload schema has held the URL to a clone source already.
    // Not echoed: it may carry a token.
    if (folder === null) throw new Error("Not a git remote URL");
    const path = await cloneRepo(url, expandHome(parentDir), folder);
    return registerNewCheckout(path, terrier, "Cloned into");
  },

  create: async ({ parentDir, name, terrier }) => {
    const path = await createRepo(expandHome(parentDir), name);
    return registerNewCheckout(path, terrier, "Created");
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
      await removeProject(id);
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

  // Terrier-sourced projects are refused by the CLI, which says to
  // update terrier instead.
  relocate: ({ id, path }) => relocateProject(id, expandHome(path)),

  // Over the whole list, terrier-only projects included: the CLI stores
  // the order apart from the registry entries, so any project can hold
  // any place. Each move goes over the list the previous one left (see
  // reorderChain), and the CLI checks the ids against its own read (one
  // added meanwhile lands last, a stale id is ignored).
  reorder: ({ draggedId, targetId, position }) => {
    const run = reorderChain.then(async () => {
      const current = loadProjects();
      const next = reorderProjects(current, draggedId, targetId, position);
      if (next === current) return;
      await storeProjectOrder(next.map((p) => p.id));
      await refreshProjects();
    });
    // The chain outlives a failed move, and the caller still sees it fail.
    reorderChain = run.catch(() => {});
    return run;
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
    (await worktreeDestination(projectId)).name,

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

  // The engine resolves icons through its shared cache (Icons.ts).
  icon: ({ projectId }) => projectIcon(projectId),
};
