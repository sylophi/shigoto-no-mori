import { cloneFolderName } from "@shared/cloneUrl";
import { fetchRemoteImage } from "@host/lib/projects/remoteImage";
import { errorWordsOf } from "@host/lib/errorWords";
import { reorderProjects } from "@shared/reorder";
import type { ViewHandlers } from "@shigomori/contracts/types";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Views from "@host/lib/Views";
import { gitContract } from "@shigomori/contracts/modules/git";
import * as Git from "@shigomori/engine/Git";
import { cloneUrlOf } from "@shigomori/contracts/predicates/remoteUrl";
import { GithubCli } from "@host/lib/githubCli/GithubCli";
import { projectsContract } from "@shigomori/contracts/modules/projects";
import {
  addProject,
  defaultBranchOf,
  findProject,
  freshProjects,
  handedCloneUrl,
  listProjectsWithStatus,
  loadProjects,
  refresh,
  relocateProject,
} from "@host/lib/projects";
import * as CarryOver from "@shigomori/engine/CarryOver";
import * as Scripts from "@host/lib/Scripts";
import type { HostServices } from "@host/process/services";
import * as Terrier from "@shigomori/engine/Terrier";
import * as Worktrees from "@host/lib/Worktrees";
import { expandHome } from "@shared/paths";
import type * as Engine from "@host/lib/Engine";
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
// add's reason. Uninterruptible: once the checkout exists, a Cancel or a
// caller gone would leave it unregistered, so it is registered whatever
// the caller did and shows up through the projects watch.
const registerNewCheckout = (
  path: string,
  terrier: boolean | undefined,
  made: string,
) =>
  register(path, terrier).pipe(
    Effect.uninterruptible,
    Effect.mapError(
      (cause) =>
        new CheckoutUnregisteredError({
          path,
          made,
          reason: errorWordsOf(cause),
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

// Over https to a GitHub host, with the device's gh signed in, gh is
// git's credential helper for a clone, so a private repository clones
// without `gh auth setup-git` having been run. Written into the clone's
// config too, scoped to that host the way setup-git scopes it, so the
// app's later fetches and pushes sign in the same way.
const ghCredentials = Effect.fnUntraced(function* (url: string) {
  if (!/^https:\/\//i.test(url)) return [];
  const cli = yield* GithubCli;
  const host = yield* cli.hostOf(url);
  if (host === null || (yield* cli.unavailableReason) !== null) return [];
  const key = `credential.https://${host}.helper`;
  return [
    [key, ""],
    [key, "!gh auth git-credential"],
  ] as const;
});

export const projectsHandlers = {
  list: () => listProjectsWithStatus,

  add: ({ path: rawPath, terrier }) =>
    Effect.gen(function* () {
      const path = expandHome(rawPath);
      if (!(yield* (yield* Git.Git).isRepo(path))) {
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
      const source = cloneUrlOf(url);
      const path = yield* (yield* Git.Git).clone({
        url: source,
        parentDir: expandHome(parentDir),
        name: folder,
        config: yield* ghCredentials(source),
      });
      return yield* registerNewCheckout(path, terrier, "Cloned into");
    }),

  create: ({ parentDir, name, terrier }) =>
    Effect.gen(function* () {
      const path = yield* (yield* Git.Git).createRepository(
        expandHome(parentDir),
        name,
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
      // The mark blocks a renderer script run from spawning into the
      // project for the whole removal, so the reap below snapshots a set
      // nothing can add to. Registry drop and per-project state deletion
      // (the icon cache entry included) run in the engine, as `sm
      // projects remove` runs them.
      const scripts = yield* Scripts.Scripts;
      yield* scripts.removingProject(
        id,
        Effect.andThen(Ops.removeProject(id), scripts.reapRemovedProjects),
      );
    }),

  // Terrier-sourced projects are refused by the engine, which says to
  // update terrier instead.
  relocate: ({ id, path }) => relocateProject(id, expandHome(path)),

  // Over the whole list, terrier-only projects included: the engine stores
  // the order apart from the registry entries, so any project can hold
  // any place. Each move goes over the list the previous one left (see
  // reorders), and the engine checks the ids against its own read (one
  // added meanwhile lands last, a stale id is ignored).
  reorder: ({ draggedId, targetId, position }) =>
    Effect.gen(function* () {
      const current = loadProjects();
      const next = reorderProjects(current, draggedId, targetId, position);
      if (next === current) return;
      yield* Ops.storeProjectOrder(next.map((p) => p.id));
      yield* refresh;
    }).pipe(reorders.withPermits(1)),

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
