// Adding and removing projects: the registry's entry, and what a new
// project starts with.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Config from "./Config.ts";
import * as Git from "./Git.ts";
import * as Paths from "./Paths.ts";
import * as Registry from "./Registry.ts";
import * as Scripts from "./Scripts.ts";
import * as Terrier from "./Terrier.ts";
import { worktreeIdFromPath } from "./worktreeLayout.ts";
import * as Worktrees from "./Worktrees.ts";

export class NotARepository extends Schema.TaggedError<NotARepository>()(
  "NotARepository",
  { path: Schema.String },
) {
  override get message(): string {
    return `${this.path} is not a git repository`;
  }
}

export class NotADirectory extends Schema.TaggedError<NotADirectory>()(
  "NotADirectory",
  { path: Schema.String },
) {
  override get message(): string {
    return `${this.path} is not a directory`;
  }
}

// terrier's projects are terrier's to remove.
export class ListedByTerrier extends Schema.TaggedError<ListedByTerrier>()(
  "ListedByTerrier",
  { name: Schema.String, binary: Schema.String },
) {
  override get message(): string {
    return `${this.name} is registered via terrier, not ${this.binary}. Unregister it with \`terrier rm ${this.name}\`, or turn the terrier integration off.`;
  }
}

// The repos under a folder that aren't projects yet, each at its primary
// checkout, and how many there already are.
export type Found = {
  readonly repos: ReadonlyArray<string>;
  readonly known: number;
};

// What removing a project leaves: its worktrees on disk, and whether
// terrier still lists it.
export type Leftovers = {
  readonly worktrees: number;
  readonly stillListed: boolean;
};

export class Projects extends Context.Service<
  Projects,
  {
    // Adds the repository `path` is in, at its primary checkout, so a
    // folder inside it or one of its worktrees names the repo.
    readonly add: (
      path: string,
    ) => Effect.Effect<
      Registry.RegisteredProject,
      NotARepository | Registry.ProjectAlreadyAdded
    >;
    // Adds a repository at its primary checkout.
    readonly register: (
      primaryPath: string,
    ) => Effect.Effect<
      Registry.RegisteredProject,
      Registry.ProjectAlreadyAdded
    >;
    // The outermost repositories six levels under `root`, the way the
    // app's folder scan finds them, less the registered ones.
    readonly scan: (root: string) => Effect.Effect<Found, NotADirectory>;
    // Drops the entry once `confirm` has seen what stays behind. Its
    // checkouts stay on disk.
    readonly remove: <E, R>(
      project: Registry.ListedProject,
      confirm: (leftovers: Leftovers) => Effect.Effect<void, E, R>,
    ) => Effect.Effect<void, E | ListedByTerrier | Registry.UnknownProject, R>;
  }
>()("sm/engine/Projects") {}

// Folders that virtually never hold a repo and are huge to walk.
const SKIPPED = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "vendor",
  "venv",
  ".venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
]);

const SCAN_DEPTH = 6;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.Git;
  const config = yield* Config.Config;
  const registry = yield* Registry.Registry;
  const scripts = yield* Scripts.Scripts;
  const terrier = yield* Terrier.Terrier;
  const worktrees = yield* Worktrees.Worktrees;
  const { binaryName } = yield* Paths.Paths;

  const deviceOn = (key: string) =>
    config.get({ kind: "device" }, key).pipe(
      Effect.map(({ value }) => value === true),
      Effect.orElseSucceed(() => false),
    );

  // What a project starts with: auto-pull on its primary per the
  // autoPullNew setting, its default branch, and a `<pm> install` setup
  // script per autoPopulateInstall. Best effort: a repo without a
  // default branch stays unconfigured until its first setting.
  const seed = (project: Registry.RegisteredProject) =>
    Effect.gen(function* () {
      if (yield* deviceOn("autoPullNew")) {
        yield* registry.setMark(
          "autoPull",
          worktreeIdFromPath(project.path),
          true,
        );
      }
      const scope = {
        kind: "project",
        projectId: project.id,
        path: project.path,
      } as const;
      const branch = yield* git.resolveDefaultBranch(project.path);
      if (Option.isSome(branch)) {
        yield* config.set(scope, "defaultBranch", branch.value);
      }
      if (yield* deviceOn("autoPopulateInstall")) {
        const manager = yield* scripts.packageManager(project.path);
        if (Option.isSome(manager)) {
          yield* config.set(scope, "scripts.setup", `${manager.value} install`);
        }
      }
    }).pipe(Effect.ignore);

  const register = Effect.fn("Projects.register")(function* (
    primaryPath: string,
  ) {
    const project = yield* registry.register({
      name: path.basename(primaryPath),
      path: primaryPath,
    });
    yield* seed(project);
    return project;
  });

  const add = Effect.fn("Projects.add")(function* (at: string) {
    const repo = yield* git.locate(at);
    if (Option.isNone(repo)) return yield* new NotARepository({ path: at });
    return yield* register(repo.value.primaryPath);
  });

  // Not a symlink: readLink answers only for one.
  const isLink = (file: string) =>
    fs.readLink(file).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const isDirectory = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  // A repo is recorded and not descended into. A worktree's .git file
  // doesn't make one.
  const walk = (
    dir: string,
    depth: number,
  ): Effect.Effect<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      if (depth > SCAN_DEPTH) return [];
      const names = yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): string[] => []));
      const dirs = yield* Effect.filter(
        names,
        (name) =>
          Effect.map(
            Effect.all([
              isDirectory(path.join(dir, name)),
              isLink(path.join(dir, name)),
            ]),
            ([directory, link]) => directory && !link,
          ),
        { concurrency: 16 },
      );
      if (dirs.includes(".git")) return [dir];
      const nested = yield* Effect.forEach(
        dirs.filter((name) => !name.startsWith(".") && !SKIPPED.has(name)),
        (name) => walk(path.join(dir, name), depth + 1),
        { concurrency: 4 },
      );
      return nested.flat();
    });

  const scan = Effect.fn("Projects.scan")(function* (root: string) {
    if (!(yield* isDirectory(root))) {
      return yield* new NotADirectory({ path: root });
    }
    // Against the registry alone: a repo terrier lists is added as an
    // ordinary project, as a single add does.
    const registered = new Set(
      (yield* registry.projects).map((project) => project.path),
    );
    const repos: string[] = [];
    let known = 0;
    // Folded to the primary checkout like a single add, so a spelling of
    // `root` that isn't the registered one still matches it.
    for (const found of (yield* walk(root, 0)).toSorted()) {
      const primary = registered.has(found)
        ? found
        : Option.match(yield* git.locate(found), {
            onNone: () => found,
            onSome: ({ primaryPath }) => primaryPath,
          });
      if (registered.has(primary)) known++;
      else repos.push(primary);
    }
    return { repos, known };
  });

  const remove = <E, R>(
    project: Registry.ListedProject,
    confirm: (leftovers: Leftovers) => Effect.Effect<void, E, R>,
  ) =>
    Effect.gen(function* () {
      if (project.source === "terrier") {
        return yield* new ListedByTerrier({
          name: project.name,
          binary: binaryName,
        });
      }
      const checkouts = yield* worktrees
        .identities(project)
        .pipe(Effect.orElseSucceed(() => []));
      const { paths } = yield* terrier.listing;
      yield* confirm({
        worktrees: checkouts.filter((checkout) => !checkout.isPrimary).length,
        stillListed: paths.includes(project.path),
      });
      yield* registry.unregister(project.id);
    }).pipe(Effect.withSpan("Projects.remove"));

  return Projects.of({ add, register, scan, remove });
});

export const layer = Layer.effect(Projects, make);
