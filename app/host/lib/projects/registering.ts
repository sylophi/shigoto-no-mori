// How this host makes and registers projects: an existing checkout
// added, a clone, a new repository, a removal and a move in the order.
// The handlers (ipc/modules/projects.ts) decode and call these.
import { cloneFolderName } from "@shared/cloneUrl";
import { expandHome } from "@shared/paths";
import { reorderProjects } from "@shared/reorder";
import { cloneUrlOf } from "@shigomori/contracts/predicates/remoteUrl";
import * as Git from "@shigomori/engine/Git";
import * as Terrier from "@shigomori/engine/Terrier";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Ops from "@host/lib/engineOps";
import { errorWordsOf } from "@host/lib/errorWords";
import { GithubCli } from "@host/lib/githubCli/GithubCli";
import * as Scripts from "@host/lib/Scripts";
import { addProject, freshProjects, loadProjects, refresh } from "./index";

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

// An existing checkout, refused unless git reads a repository there.
export const addCheckout = Effect.fn("projects.add")(function* (
  rawPath: string,
  terrier: boolean | undefined,
) {
  const path = expandHome(rawPath);
  if (!(yield* (yield* Git.Git).isRepo(path))) {
    return yield* new NotGitRepositoryError({ path });
  }
  return yield* register(path, terrier);
});

export const cloneProject = Effect.fn("projects.clone")(function* (input: {
  readonly url: string;
  readonly parentDir: string;
  readonly name?: string | undefined;
  readonly terrier?: boolean | undefined;
}) {
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

export const removeProject = Effect.fn("projects.remove")(function* (
  id: string,
) {
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
});

// Over the whole list, terrier-only projects included: the engine stores
// the order apart from the registry entries, so any project can hold
// any place. Each move goes over the list the previous one left (see
// reorders), and the engine checks the ids against its own read (one
// added meanwhile lands last, a stale id is ignored).
export const reorderProject = (input: {
  readonly draggedId: string;
  readonly targetId: string;
  readonly position: Parameters<typeof reorderProjects>[3];
}) =>
  Effect.gen(function* () {
    const current = loadProjects();
    const next = reorderProjects(
      current,
      input.draggedId,
      input.targetId,
      input.position,
    );
    if (next === current) return;
    yield* Ops.storeProjectOrder(next.map((p) => p.id));
    yield* refresh;
  }).pipe(reorders.withPermits(1), Effect.withSpan("projects.reorder"));
