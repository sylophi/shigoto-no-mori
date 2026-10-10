import { cloneFolderName, pickCloneUrl } from "@shared/cloneUrl";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { reorderProjects } from "@shared/reorder";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Views from "@host/lib/views";
import { gitContract } from "@shigomori/contracts/modules/git";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import { listBranches } from "@host/lib/git/branches";
import { cloneRepo } from "@host/lib/git/clone";
import { isGitRepo } from "@host/lib/git/core";
import { createRepo } from "@host/lib/git/init";
import { listRemoteEntries } from "@host/lib/git/remotes";
import {
  addProject,
  findProject,
  freshProjects,
  listProjectsWithStatus,
  loadProjects,
  primaryRef,
  refresh,
  relocateProject,
} from "@host/lib/projects";
import {
  listCarryOverCandidates,
  listCarryOverCheckouts,
  statCarryOverPaths,
} from "@host/lib/worktrees/carryOver";
import { readWorktreeIncludeStatus } from "@host/lib/worktrees/worktreeInclude";
import {
  clearProjectDeleteInflight,
  killScriptsForProject,
  markProjectDeleteInflight,
} from "@host/lib/scripts";
import type { HostServices } from "@host/process/services";
import * as Terrier from "@host/lib/terrier";
import { fromPromise } from "@host/lib/util/fromPromise";
import { expandHome } from "@host/lib/util/paths";
import type * as Engine from "@host/lib/engine";
import * as Ops from "@host/lib/engineOps";

// Moves run one at a time: each writes the whole order, so a second
// drag computed before the first's refresh landed would put the first
// one's project back.
const reorders = Semaphore.makeUnsafe(1);

class NotGitRepositoryError extends Schema.TaggedError<NotGitRepositoryError>()(
  "NotGitRepositoryError",
  { path: Schema.String },
) {
  override get message(): string {
    return `${this.path} is not a git repository`;
  }
}

class TerrierProjectError extends Schema.TaggedError<TerrierProjectError>()(
  "TerrierProjectError",
  { name: Schema.String },
) {
  override get message(): string {
    return `${this.name} is registered via terrier. Unregister it with \`terrier rm\`, or turn the terrier integration off in Settings.`;
  }
}

class NotGitRemoteError extends Schema.TaggedError<NotGitRemoteError>()(
  "NotGitRemoteError",
  {},
) {
  override get message(): string {
    return "Not a git remote URL";
  }
}

// A checkout the app made that could not be added as a project, which
// stays where it is.
class CheckoutUnregisteredError extends Schema.TaggedError<CheckoutUnregisteredError>()(
  "CheckoutUnregisteredError",
  {
    path: Schema.String,
    made: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.made} ${this.path}, but couldn't add it as a project: ${this.reason}`;
  }
}

// Registers a checkout the app just made (a clone, a new repository).
// The checkout stays if registering fails, so the error says where it
// is: a retry would only find the folder taken. Terrier first, for
// add's reason.
const registerNewCheckout = (
  path: string,
  terrier: boolean | undefined,
  made: string,
) =>
  register(path, terrier).pipe(
    Effect.mapError(
      (cause) =>
        new CheckoutUnregisteredError({
          path,
          made,
          reason: errorMessageOf(cause),
          cause,
        }),
    ),
  );

// Into terrier first, so registering mints the id terrier's listing of
// the repo carries (Projects.add in the engine): removing the project
// here later leaves it under the same id, its per-project state intact.
// Then the same engine as `sm projects add`: registration and the
// config seed.
const register = Effect.fn("projects.register")(function* (
  path: string,
  terrier: boolean | undefined,
) {
  if (terrier) yield* Effect.flatMap(Terrier.Terrier, (it) => it.add(path));
  return yield* addProject(path);
});

// Every checkout of the project, the primary first, for what is carried
// over into a new worktree.
const checkoutsOf = (projectId: string) =>
  Effect.flatMap(findProject(projectId), (project) =>
    listCarryOverCheckouts(project.id, project.path),
  );

export const projectsViews: ViewHandlers<
  typeof projectsContract,
  Views.Services | Engine.Services
> = {
  // The usage log orders the list, and the device config says whether
  // terrier's projects join it. A project's remote is git's, which the
  // git watcher announces (a publish's push). Terrier's identities and
  // a missing folder are neither, and show on the next of these.
  watch: () =>
    Views.view(
      "projects:watch",
      () => listProjectsWithStatus,
      Views.either(
        Views.wrote(
          "projects",
          "project_order",
          "project_config",
          "usage",
          "device_config",
        ),
        Views.pushed(gitContract, "projectChanged"),
      ),
    ),
};

export const projectsHandlers = {
  list: () => listProjectsWithStatus,

  add: ({ path: rawPath, terrier }) =>
    Effect.gen(function* () {
      const path = expandHome(rawPath);
      if (!(yield* fromPromise(() => isGitRepo(path)))) {
        return yield* new NotGitRepositoryError({ path });
      }
      return yield* register(path, terrier);
    }),

  clone: ({ url, parentDir, name, terrier }) =>
    Effect.gen(function* () {
      const folder = name ?? cloneFolderName(url);
      // The payload schema has held the URL to a clone source already.
      // Not echoed: it may carry a token.
      if (folder === null) return yield* new NotGitRemoteError();
      const path = yield* cloneRepo(url, expandHome(parentDir), folder);
      return yield* registerNewCheckout(path, terrier, "Cloned into");
    }),

  create: ({ parentDir, name, terrier }) =>
    Effect.gen(function* () {
      const path = yield* fromPromise(() =>
        createRepo(expandHome(parentDir), name),
      );
      return yield* registerNewCheckout(path, terrier, "Created");
    }),

  remove: ({ id }) =>
    Effect.gen(function* () {
      const removed = (yield* freshProjects).find((p) => p.id === id);
      if (!removed) return;
      if (removed.source === "terrier") {
        // The UI disables removal for terrier-sourced projects, so this
        // only backstops a stale renderer list.
        return yield* new TerrierProjectError({ name: removed.name });
      }
      // The inflight mark blocks a renderer script run from spawning
      // into the project for the whole removal, so the reap below
      // snapshots a set nothing can add to.
      yield* Effect.acquireUseRelease(
        Effect.sync(() => markProjectDeleteInflight(id)),
        () =>
          Effect.gen(function* () {
            // Registry drop and per-project state deletion (the icon
            // cache entry included) run in the CLI, same engine as `sm
            // projects remove`.
            yield* Ops.removeProject(id);
            // A path terrier also registers doesn't leave the sidebar:
            // dropping the registry entry just demotes it to a
            // terrier-sourced project, and when the id carries over
            // (registration minted the deterministic terrier id) nothing
            // is actually going away. Read from the list the removal
            // left behind, so the answer is the CLI's own, not a guess
            // at its rule.
            const survived = (yield* refresh).some((p) => p.id === id);
            // Reap scripts running in this project's worktrees: once the
            // id is gone the renderer has no UI left to stop them, and
            // the per-worktree delete path (which would normally kill
            // them) can't be reached for an unknown project.
            if (!survived) yield* killScriptsForProject(id);
          }),
        () => Effect.sync(() => clearProjectDeleteInflight(id)),
      );
    }),

  // Terrier-sourced projects are refused by the CLI, which says to
  // update terrier instead.
  relocate: ({ id, path }) => relocateProject(id, expandHome(path)),

  // Over the whole list, terrier-only projects included: the CLI stores
  // the order apart from the registry entries, so any project can hold
  // any place. Each move goes over the list the previous one left (see
  // reorders), and the CLI checks the ids against its own read (one
  // added meanwhile lands last, a stale id is ignored).
  reorder: ({ draggedId, targetId, position }) =>
    Effect.gen(function* () {
      const current = loadProjects();
      const next = reorderProjects(current, draggedId, targetId, position);
      if (next === current) return;
      yield* Ops.storeProjectOrder(next.map((p) => p.id));
      yield* refresh;
    }).pipe(reorders.withPermits(1)),

  // The primary ref every row is measured against, which the CLI
  // resolves once per project (the configured override first).
  defaultBranch: ({ projectId }) =>
    Effect.flatMap(findProject(projectId), primaryRef),

  cloneUrl: ({ projectId }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      fromPromise(() => listRemoteEntries(project.path)),
    ).pipe(Effect.map(pickCloneUrl)),

  listBranches: ({ projectId }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      fromPromise(() => listBranches(project.path)),
    ),

  // The name the CLI would pick for a new worktree right now.
  pickWorktreeName: ({ projectId }) =>
    Effect.map(Ops.worktreeDestination(projectId), ({ name }) => name),

  worktreeIncludeStatus: ({ projectId }) =>
    Effect.flatMap(checkoutsOf(projectId), (checkouts) =>
      fromPromise(() => readWorktreeIncludeStatus(checkouts)),
    ),

  carryOverListing: ({ projectId, relative, ruleIgnored }) =>
    Effect.flatMap(checkoutsOf(projectId), (checkouts) =>
      fromPromise(() =>
        listCarryOverCandidates(checkouts, relative, { ruleIgnored }),
      ),
    ),

  carryOverStats: ({ projectId, paths }) =>
    Effect.flatMap(checkoutsOf(projectId), (checkouts) =>
      fromPromise(() => statCarryOverPaths(checkouts, paths)),
    ),

  // The engine resolves icons through its shared cache (Icons.ts).
  icon: ({ projectId }) => Ops.projectIcon(projectId),
} satisfies Handlers<typeof projectsContract, unknown, HostServices>;
