import { expandHome } from "@shared/paths";
import { fetchRemoteImage } from "@host/lib/projects/remoteImage";
import type { ViewHandlers } from "@shigomori/contracts/types";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Views from "@host/lib/Views";
import { gitContract } from "@shigomori/contracts/modules/git";
import * as Git from "@shigomori/engine/Git";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import {
  addCheckout,
  cloneProject,
  createProject,
  removeProject,
  reorderProject,
} from "@host/lib/projects/registering";
import {
  defaultBranchOf,
  findProject,
  handedCloneUrl,
  listProjectsWithStatus,
  relocateProject,
} from "@host/lib/projects";
import * as CarryOver from "@shigomori/engine/CarryOver";
import type { HostServices } from "@host/process/services";
import * as Worktrees from "@host/lib/Worktrees";
import type * as Engine from "@host/lib/Engine";
import * as Ops from "@host/lib/engineOps";

// Every checkout of the project, the primary first, for what is carried
// over into a new worktree.
const checkoutsOf = (projectId: string) =>
  Effect.flatMap(
    Effect.all([findProject(projectId), Worktrees.Worktrees]),
    ([project, worktrees]) =>
      worktrees.carryOverCheckouts(project.id, project.path),
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

  add: ({ path, terrier }) => addCheckout(path, terrier),

  clone: (input) => cloneProject(input),

  create: (input) => createProject(input),

  remove: ({ id }) => removeProject(id),

  relocate: ({ id, path }) => relocateProject(id, expandHome(path)),

  reorder: (input) => reorderProject(input),

  defaultBranch: ({ projectId }) =>
    Effect.map(
      Effect.flatMap(findProject(projectId), defaultBranchOf),
      ({ ref }) => ref,
    ),

  cloneUrl: ({ projectId }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      handedCloneUrl(project.path),
    ),

  listBranches: ({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      return yield* (yield* Git.Git).listBranches(project.path);
    }),

  // The name the engine would pick for a new worktree right now.
  pickWorktreeName: ({ projectId }) =>
    Effect.map(Ops.worktreeDestination(projectId), ({ name }) => name),

  worktreeIncludeStatus: ({ projectId }) =>
    Effect.flatMap(
      Effect.all([checkoutsOf(projectId), CarryOver.CarryOver]),
      ([checkouts, carryOver]) =>
        carryOver.includeStatus(checkouts.map(({ path }) => path)),
    ),

  carryOverListing: ({ projectId, relative, ruleIgnored }) =>
    Effect.flatMap(
      Effect.all([checkoutsOf(projectId), Worktrees.Worktrees]),
      ([checkouts, worktrees]) =>
        worktrees.carryOverCandidates(checkouts, relative, { ruleIgnored }),
    ),

  carryOverStats: ({ projectId, paths }) =>
    Effect.flatMap(
      Effect.all([checkoutsOf(projectId), Worktrees.Worktrees]),
      ([checkouts, worktrees]) => worktrees.carryOverStats(checkouts, paths),
    ),

  // The engine resolves icons through its shared cache (Icons.ts).
  icon: ({ projectId }) => Ops.projectIcon(projectId),

  remoteImage: ({ projectId, url }) =>
    Effect.gen(function* () {
      const project = yield* findProject(projectId);
      const remotes = yield* (yield* Git.Git).listRemoteEntries(project.path);
      return yield* fetchRemoteImage(
        remotes.map((remote) => remote.url),
        url,
      );
    }),
} satisfies EffectHandlers<typeof projectsContract, unknown, HostServices>;
