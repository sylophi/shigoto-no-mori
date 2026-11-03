// How this host makes and registers projects: an existing checkout
// added, a clone, a new repository, a removal and a move in the order.
// The handlers (ipc/modules/projects.ts) decode and call these.
import { cloneFolderName } from "@shared/cloneUrl";
import { expandHome } from "@shared/paths";
import { reorderProjects } from "@shared/reorder";
import type { CloneProgressPush } from "@shigomori/contracts/modules/projects";
import {
  cloneUrlOf,
  githubRepoOf,
} from "@shigomori/contracts/predicates/remoteUrl";
import * as Git from "@shigomori/engine/Git";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Projects from "@shigomori/engine/Projects";
import * as Registry from "@shigomori/engine/Registry";
import { changing } from "@host/lib/Engine";
import { messageOf } from "@shigomori/engine/errorDocument";
import { GithubCli } from "@host/lib/githubCli/GithubCli";
import * as Scripts from "@host/lib/Scripts";
import { bookingScripts } from "@host/lib/worktrees/documents";
import { addProject, findProject, listedProjects } from "./index";

// Moves run one at a time: each writes the whole order, so a second
// drag computed before the first's write landed would put the first
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
// is: a retry would only find the folder taken. Uninterruptible: once
// the checkout exists, a Cancel or a caller gone would leave it
// unregistered, so it is registered whatever the caller did and shows
// up through the projects watch.
const registerNewCheckout = (
  path: string,
  terrier: boolean | undefined,
  made: string,
) =>
  addProject(path, terrier).pipe(
    Effect.uninterruptible,
    Effect.mapError(
      (cause) =>
        new CheckoutUnregisteredError({
          path,
          made,
          reason: messageOf(cause),
          cause,
        }),
    ),
  );

// Over https to a GitHub host, with the device's gh signed in, gh is
// git's credential helper for a clone, so a private repository clones
// without `gh auth setup-git` having been run. Written into the clone's
// config too, scoped to that host the way setup-git scopes it, so the
// app's later fetches and pushes sign in the same way.
const ghCredentials = Effect.fnUntraced(function* (url: string) {
  if (!/^https:\/\//i.test(url)) return [];
  const cli = yield* GithubCli;
  const host = githubRepoOf(url)?.host;
  if (host === undefined || !(yield* cli.knownHosts).has(host)) return [];
  if ((yield* cli.unavailableReason) !== null) return [];
  const key = `credential.https://${host}.helper`;
  return [
    [key, ""],
    [key, "!gh auth git-credential"],
  ] as const;
});

// An existing checkout, refused unless git reads a repository there.
export const addCheckout = Effect.fn("projects.add")(function* (
  rawPath: string,
  terrier: boolean | undefined,
) {
  const path = expandHome(rawPath);
  if (!(yield* (yield* Git.Git).isRepo(path))) {
    return yield* new NotGitRepositoryError({ path });
  }
  return yield* addProject(path, terrier);
});

export const cloneProject = Effect.fn("projects.clone")(function* (
  input: {
    readonly url: string;
    readonly parentDir: string;
    readonly name?: string | undefined;
    readonly terrier?: boolean | undefined;
  },
  notify: (push: CloneProgressPush) => void,
) {
  const folder = input.name ?? cloneFolderName(input.url);
  // The payload schema has held the URL to a clone source already.
  // Not echoed: it may carry a token.
  if (folder === null) return yield* new NotGitRemoteError();
  const source = cloneUrlOf(input.url);
  const path = yield* (yield* Git.Git).clone({
    url: source,
    parentDir: expandHome(input.parentDir),
    name: folder,
    config: yield* ghCredentials(source),
    onProgress: (progress) =>
      Effect.sync(() =>
        notify({ parentDir: input.parentDir, name: folder, progress }),
      ),
  });
  return yield* registerNewCheckout(path, input.terrier, "Cloned into");
});

export const createProject = Effect.fn("projects.create")(function* (input: {
  readonly parentDir: string;
  readonly name: string;
  readonly terrier?: boolean | undefined;
}) {
  const path = yield* (yield* Git.Git).createRepository(
    expandHome(input.parentDir),
    input.name,
  );
  return yield* registerNewCheckout(path, input.terrier, "Created");
});

// The mark blocks a renderer script run from spawning into the project
// for the whole removal, so the reap after it snapshots a set nothing
// can add to. Registry drop and per-project state deletion (the icon
// cache entry included) run in the engine, as `sm projects unregister`
// runs them.
const removing = Effect.fnUntraced(function* <E, R>(
  id: string,
  removal: (scripts: Scripts.Scripts["Service"]) => Effect.Effect<void, E, R>,
) {
  if (!(yield* listedProjects).some((p) => p.id === id)) return;
  const scripts = yield* Scripts.Scripts;
  yield* scripts.removingProject(
    id,
    Effect.andThen(removal(scripts), scripts.reapRemovedProjects),
  );
});

export const removeProject = Effect.fn("projects.remove")((id: string) =>
  removing(id, () =>
    changing(
      Effect.flatMap(findProject(id), (project) =>
        Effect.flatMap(Projects.Projects, (projects) =>
          projects.remove(project),
        ),
      ),
      { projectId: id },
    ),
  ),
);

// Its scripts are stopped once nothing refuses the delete, as a
// worktree's removal stops them, and the worktrees' teardowns are told
// to `notify`.
export const deleteProject = Effect.fn("projects.delete")(
  (id: string, notify: Scripts.NotifyScriptEvent) =>
    removing(id, (scripts) =>
      Effect.gen(function* () {
        const projects = yield* Projects.Projects;
        const project = yield* findProject(id);
        yield* projects.checkDeletable(project);
        yield* scripts.stopProject(id);
        yield* bookingScripts(scripts, notify, (reporter) =>
          projects.removeWithFiles(project, reporter),
        );
      }),
    ),
);

// Over the whole list, terrier-only projects included: the engine stores
// the order apart from the registry entries, so any project can hold
// any place. Each move goes over the list as the previous one left it
// (see reorders).
export const reorderProject = Effect.fn("projects.reorder")(function* (input: {
  readonly draggedId: string;
  readonly targetId: string;
  readonly position: Parameters<typeof reorderProjects>[3];
}) {
  const registry = yield* Registry.Registry;
  const current = yield* registry.listed;
  const next = reorderProjects(
    current,
    input.draggedId,
    input.targetId,
    input.position,
  );
  if (next === current) return;
  yield* registry.reorder(
    current,
    next.map((p) => p.id),
  );
}, reorders.withPermits(1));
