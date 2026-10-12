import { join } from "node:path";
import { cloneFolderName, pickCloneUrl } from "@shared/cloneUrl";
import { errorMessageOf } from "@shared/errors";
import { reorderProjects } from "@shared/reorder";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import type { CancelClonePayload, Project } from "@shared/schemas";
import { projectsContract } from "@shared/ipc/modules/projects";
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
  projectIconViaCli,
  projectsRemoveViaCli,
  reorderProjectsViaCli,
  worktreeDestinationViaCli,
} from "../cliDelegate";

// Moves run one at a time: each writes the whole order, so a second
// drag computed before the first's refresh landed would put the first
// one's project back.
let reorderChain: Promise<void> = Promise.resolve();

// The clones in flight on this host, so one can be cancelled: keyed by
// the calling device and the destination, so a cancel finds only a
// clone its own caller started.
const clones = new Map<string, AbortController>();

function cloneKey(
  ctx: Pick<HandlerContext, "callerDeviceId">,
  { parentDir, name }: CancelClonePayload,
): string {
  return `${ctx.callerDeviceId ?? ""}:${join(expandHome(parentDir), name)}`;
}

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

export const projectsHandlers: Handlers<
  typeof projectsContract,
  HandlerContext
> = {
  list: () => listProjectsWithStatus(),

  add: async ({ path: rawPath, terrier }) => {
    const path = expandHome(rawPath);

    if (!(await isGitRepo(path))) {
      throw new Error(`${path} is not a git repository`);
    }

    // Into terrier first, so registering mints the id terrier's listing
    // of the repo carries (registerProject in cli/cmd_project.go):
    // removing the project here later leaves it under the same id, its
    // per-project state intact.
    if (terrier) await terrierAdd(path);
    // Same engine as `sm projects add`: registration and the config
    // seed run in the CLI.
    return registerProject(path);
  },

  clone: async ({ url, parentDir, name, terrier }, ctx) => {
    const folder = name ?? cloneFolderName(url);
    // The payload schema has held the URL to a clone source already.
    // Not echoed: it may carry a token.
    if (folder === null) throw new Error("Not a git remote URL");
    const key = cloneKey(ctx, { parentDir, name: folder });
    // One clone per key, or the second would take the first's cancel.
    if (clones.has(key)) throw new Error("That folder is being cloned into");
    const controller = new AbortController();
    clones.set(key, controller);
    let path: string;
    try {
      path = await cloneRepo(
        url,
        expandHome(parentDir),
        folder,
        controller.signal,
      );
    } finally {
      clones.delete(key);
    }
    return registerNewCheckout(path, terrier, "Cloned into");
  },

  cancelClone: (payload, ctx) => {
    clones.get(cloneKey(ctx, payload))?.abort();
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
      await reorderProjectsViaCli(next.map((p) => p.id));
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
