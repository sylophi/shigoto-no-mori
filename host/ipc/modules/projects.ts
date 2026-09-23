import { Effect } from "effect";
import { pickCloneUrl, repoNameFromUrl } from "@shared/cloneUrl";
import { errorMessageOf } from "@shared/errors";
import { reorderProjects } from "@shared/reorder";
import type { Project } from "@shared/schemas";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { projectsContract } from "@shared/ipc/modules/projects";
import { readShigomoriConfig } from "@host/lib/config/project";
import { PROJECTS_KEY, registryStore } from "@host/lib/config/store";
import { listBranches } from "@host/lib/git/branches";
import { cloneRepo } from "@host/lib/git/clone";
import { isGitRepo } from "@host/lib/git/core";
import { listRemoteEntries, resolveDefaultBranch } from "@host/lib/git/remotes";
import { pickAvailableWorktreeName } from "@host/lib/git/worktrees";
import {
  findProjectOrThrow,
  listProjectsWithStatus,
  loadProjects,
} from "@host/lib/projects";
import {
  forgetProjectIcon,
  readProjectIconEffect,
} from "@host/lib/projects/icon";
import {
  dropCollapsedProject,
  readCollapsedProjects,
  toggleCollapsedProject,
} from "@host/lib/projects/collapsed";
import { readProjectSort, writeProjectSort } from "@host/lib/projects/usage";
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
import {
  invalidateTerrierCaches,
  refreshTerrierListings,
  terrierRetainsProject,
} from "@host/lib/terrier";
import { expandHome } from "@host/lib/util/paths";
import { hostAttempt, hostHandler } from "@host/runtime";
import { projectsAddViaCli, projectsRemoveViaCli } from "../cliDelegate";

// The project a handler is about, as its first step: an unknown id
// fails with the very UnknownProject findProjectOrThrow throws.
const projectOf = (projectId: string) =>
  hostAttempt(() => findProjectOrThrow(projectId));

// Clone, then register the checkout. One step: a caller that leaves
// mid-clone stops waiting, never the pair, so a finished clone is
// always registered or reported.
async function cloneAndAdd(
  url: string,
  parentDir: string,
  folder: string,
): Promise<Project> {
  const path = await cloneRepo(url, expandHome(parentDir), folder);
  // The checkout stays if registering fails, so the error says where
  // it is: a retry would only find the folder taken.
  return projectsAddViaCli(path).catch((error: unknown) => {
    throw new Error(
      `Cloned into ${path}, but couldn't add it as a project: ${errorMessageOf(error)}`,
    );
  });
}

async function removeProject(id: string): Promise<void> {
  const removed = loadProjects().find((p) => p.id === id);
  if (!removed) return;
  if (removed.source === "terrier") {
    // The UI disables removal for terrier-sourced projects, so this
    // only backstops a stale renderer list.
    throw new Error(
      `${removed.name} is registered via terrier. Unregister it with \`terrier rm\`, or turn the terrier integration off in Settings.`,
    );
  }
  // A path terrier also registers doesn't leave the sidebar: dropping
  // the registry entry just demotes it to a terrier-sourced project.
  // When the id carries over (registration minted the deterministic
  // terrier id), nothing is actually going away: skip the script
  // reaping and the app-side cleanup, and let the CLI skip the state
  // dir for the same reason. Decided from a just-expired, freshly
  // refetched listing rather than the snapshot: the CLI re-derives
  // the same rule from a live read, and a stale answer here would
  // half-apply the removal (scripts killed for a project that stays,
  // or cleanup skipped for one that goes).
  invalidateTerrierCaches();
  await refreshTerrierListings();
  if (terrierRetainsProject(removed)) {
    await projectsRemoveViaCli(id);
    return;
  }
  // Reap scripts running in this project's worktrees before dropping
  // the registry entry: once the id is gone the renderer has no UI
  // left to stop them, and the per-worktree delete path (which would
  // normally kill them) can't be reached for an unknown project.
  // The inflight mark blocks a renderer script run from spawning into
  // the project during the kill window. The kill snapshots running
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
}

export const projectsHandlers: Handlers<
  typeof projectsContract,
  HandlerContext
> = {
  list: hostHandler(() => hostAttempt(() => listProjectsWithStatus())),

  add: hostHandler(({ path: rawPath }) =>
    Effect.gen(function* () {
      const path = expandHome(rawPath);
      if (!(yield* hostAttempt(() => isGitRepo(path)))) {
        return yield* Effect.fail(new Error(`${path} is not a git repository`));
      }
      // Same engine as `sm projects add`: registration and the config
      // seed run in the CLI.
      return yield* hostAttempt(() => projectsAddViaCli(path));
    }),
  ),

  clone: hostHandler(({ url, parentDir, name }) =>
    Effect.gen(function* () {
      const folder = name ?? repoNameFromUrl(url);
      // The payload schema has held the URL to a remote already. Not
      // echoed: it may carry a token.
      if (folder === null) {
        return yield* Effect.fail(new Error("Not a git remote URL"));
      }
      return yield* hostAttempt(() => cloneAndAdd(url, parentDir, folder));
    }),
  ),

  // One step through the reaping, the CLI removal and the app-side
  // cleanup, so a caller that leaves mid-removal stops waiting, not
  // the removal.
  remove: hostHandler(({ id }) =>
    hostAttempt(() => removeProject(id)).pipe(Effect.as(undefined)),
  ),

  reorder: hostHandler(({ draggedId, targetId, position }) =>
    // updateKey so the current list is read under the cross-process
    // lock: the CLI writes this key too (sm projects add), and deriving
    // the new list from a read taken outside the lock would clobber a
    // concurrent CLI write.
    hostAttempt(() => {
      registryStore.updateKey<Project[]>(PROJECTS_KEY, [], (current) =>
        reorderProjects(current, draggedId, targetId, position),
      );
    }).pipe(Effect.as(undefined)),
  ),

  getSort: hostHandler(() => hostAttempt(() => readProjectSort())),

  setSort: hostHandler(({ mode }) =>
    hostAttempt(() => writeProjectSort(mode)).pipe(Effect.as(undefined)),
  ),

  getCollapsed: hostHandler(() => hostAttempt(() => readCollapsedProjects())),

  toggleCollapsed: hostHandler(({ projectId }) =>
    hostAttempt(() => toggleCollapsedProject(projectId)),
  ),

  defaultBranch: hostHandler(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      const config = yield* hostAttempt(() => readShigomoriConfig(project.id));
      return yield* hostAttempt(() =>
        resolveDefaultBranch(project.path, config?.defaultBranch),
      );
    }),
  ),

  cloneUrl: hostHandler(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      const remotes = yield* hostAttempt(() => listRemoteEntries(project.path));
      return pickCloneUrl(remotes);
    }),
  ),

  listBranches: hostHandler(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* hostAttempt(() => listBranches(project.path));
    }),
  ),

  pickWorktreeName: hostHandler(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* hostAttempt(() =>
        pickAvailableWorktreeName(project.id, project.path),
      );
    }),
  ),

  worktreeIncludeStatus: hostHandler(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* hostAttempt(() =>
        readWorktreeIncludeStatus(project.id, project.path),
      );
    }),
  ),

  carryOverListing: hostHandler(({ projectId, relative, ruleIgnored }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* hostAttempt(() =>
        listCarryOverCandidates(project.id, project.path, relative, {
          ruleIgnored,
        }),
      );
    }),
  ),

  carryOverStats: hostHandler(({ projectId, paths }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* hostAttempt(() =>
        statCarryOverPaths(project.id, project.path, paths),
      );
    }),
  ),

  // The one lookup here that is an Effect all the way down: concurrent
  // lookups for a project share one resolution (host/lib/projects/
  // icon.ts), and it is interrupted once every caller has left.
  icon: hostHandler(({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* projectOf(projectId);
      return yield* readProjectIconEffect(project.path);
    }),
  ),
};
