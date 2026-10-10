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
    // Adds a repository at its primary checkout, as `scan` found it.
    readonly register: (
      primaryPath: string,
    ) => Effect.Effect<
      Registry.RegisteredProject,
      Registry.ProjectAlreadyAdded
    >;
    // The outermost repositories six levels under `root`, the way the
    // app's folder scan finds them, less the registered ones.
    readonly scan: (root: string) => Effect.Effect<Found, NotADirectory>;
    // What removing the project would leave, for the question asked
    // before it.
    readonly leftovers: (
      project: Registry.ListedProject,
    ) => Effect.Effect<Leftovers, ListedByTerrier>;
    // Drops the entry. Its checkouts stay on disk.
    readonly remove: (
      project: Registry.ListedProject,
    ) => Effect.Effect<void, ListedByTerrier | Registry.UnknownProject>;
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

// A step that only adds to what a project starts with: its failure,
// or a defect under it, leaves the project as added.
const bestEffort = <A, E, R>(step: Effect.Effect<A, E, R>) =>
  step.pipe(Effect.catchCause(() => Effect.void));

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
  // script per autoPopulateInstall. A repo without a default branch
  // stays unconfigured until its first setting.
  const seed = (project: Registry.RegisteredProject) =>
    Effect.gen(function* () {
      const [autoPull, install, branch, manager] = yield* Effect.all(
        [
          deviceOn("autoPullNew"),
          deviceOn("autoPopulateInstall"),
          git.resolveDefaultBranch(project.path),
          scripts.packageManager(project.path),
        ],
        { concurrency: "unbounded" },
      );
      if (autoPull) {
        yield* bestEffort(
          registry.setMark("autoPull", worktreeIdFromPath(project.path), true),
        );
      }
      const scope = {
        kind: "project",
        projectId: project.id,
        path: project.path,
      } as const;
      if (Option.isSome(branch)) {
        yield* bestEffort(config.set(scope, "defaultBranch", branch.value));
      }
      if (install && Option.isSome(manager)) {
        yield* bestEffort(
          config.set(scope, "scripts.setup", `${manager.value} install`),
        );
      }
    }).pipe(bestEffort);

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

  // A folder, not a link to one: readLink answers only for a link.
  const isFolder = (file: string) =>
    fs.stat(file).pipe(
      Effect.flatMap((info) =>
        info.type === "Directory"
          ? fs.readLink(file).pipe(
              Effect.as(false),
              Effect.orElseSucceed(() => true),
            )
          : Effect.succeed(false),
      ),
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
      if (names.includes(".git") && (yield* isFolder(path.join(dir, ".git")))) {
        return [dir];
      }
      const folders = yield* Effect.filter(
        names.filter((name) => !name.startsWith(".") && !SKIPPED.has(name)),
        (name) => isFolder(path.join(dir, name)),
        { concurrency: 16 },
      );
      // One folder at a time, as Go walked: a wide tree can't run out of
      // file handles, which would read as folders with nothing in them.
      const nested = yield* Effect.forEach(folders, (name) =>
        walk(path.join(dir, name), depth + 1),
      );
      return nested.flat();
    });

  const scan = Effect.fn("Projects.scan")(function* (root: string) {
    const rootInfo = yield* fs.stat(root).pipe(Effect.option);
    if (Option.isNone(rootInfo) || rootInfo.value.type !== "Directory") {
      return yield* new NotADirectory({ path: root });
    }
    // Against the registry alone: a repo terrier lists is added as an
    // ordinary project, as a single add does.
    const registered = new Set(
      (yield* registry.projects).map((project) => project.path),
    );
    // Folded to the primary checkout like a single add, so a spelling of
    // `root` that isn't the registered one still matches it. A repo git
    // can't read stays as found.
    const primaries = yield* Effect.forEach(
      (yield* walk(root, 0)).toSorted(),
      (found) =>
        registered.has(found)
          ? Effect.succeed(found)
          : Effect.map(git.locate(found), (repo) =>
              Option.match(repo, {
                onNone: () => found,
                onSome: ({ primaryPath }) => primaryPath,
              }),
            ),
      { concurrency: 8 },
    );
    const repos = primaries.filter((primary) => !registered.has(primary));
    return { repos, known: primaries.length - repos.length };
  });

  const refuseTerrier = (project: Registry.ListedProject) =>
    project.source === "terrier"
      ? Effect.fail(
          new ListedByTerrier({ name: project.name, binary: binaryName }),
        )
      : Effect.void;

  const leftovers = Effect.fn("Projects.leftovers")(function* (
    project: Registry.ListedProject,
  ) {
    yield* refuseTerrier(project);
    const [checkouts, { paths }] = yield* Effect.all(
      [
        worktrees.identities(project).pipe(Effect.orElseSucceed(() => [])),
        terrier.listing,
      ],
      { concurrency: 2 },
    );
    return {
      worktrees: checkouts.filter((checkout) => !checkout.isPrimary).length,
      stillListed: paths.includes(project.path),
    };
  });

  const remove = Effect.fn("Projects.remove")(function* (
    project: Registry.ListedProject,
  ) {
    yield* refuseTerrier(project);
    yield* registry.unregister(project.id);
  });

  return Projects.of({ add, register, scan, leftovers, remove });
});

export const layer = Layer.effect(Projects, make);
