// Adding and removing projects: the registry's entry, and what a new
// project starts with.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
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

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* Git.Git;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* Config.Config;
  const registry = yield* Registry.Registry;
  const scripts = yield* Scripts.Scripts;
  const terrier = yield* Terrier.Terrier;
  const worktrees = yield* Worktrees.Worktrees;
  const { binaryName } = yield* Paths.Paths;

  // What a project starts with: auto-pull on its primary per the
  // autoPullNew setting, its default branch, and a `<pm> install` setup
  // script per autoPopulateInstall. A repo without a default branch
  // stays unconfigured until its first setting. Read before the
  // register, whose transaction writes it.
  const seedOf = (primaryPath: string) =>
    Effect.all(
      [
        config.device("autoPullNew"),
        config.device("autoPopulateInstall"),
        // git's and the folder's answers are hints: one that fails seeds
        // nothing of its own.
        git
          .resolveDefaultBranch(primaryPath)
          .pipe(Effect.orElseSucceed(() => Option.none<string>())),
        scripts
          .packageManager(primaryPath)
          .pipe(Effect.orElseSucceed(() => Option.none<string>())),
      ],
      { concurrency: "unbounded" },
    );

  const seed = (
    project: Registry.RegisteredProject,
    [autoPull, install, branch, manager]: Effect.Success<
      ReturnType<typeof seedOf>
    >,
  ) =>
    Effect.gen(function* () {
      if (autoPull) {
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
      if (Option.isSome(branch)) {
        yield* config.set(scope, "defaultBranch", branch.value);
      }
      // A setup script is a setting a project without a default branch
      // can't take yet.
      if (install && Option.isSome(manager) && Option.isSome(branch)) {
        yield* config.set(scope, "scripts.setup", `${manager.value} install`);
      }
    }).pipe(
      // Inside the register's transaction: a write that fails takes the
      // register with it, rather than leave a project half seeded.
      Effect.orDie,
    );

  // The project and its seed in one transaction: a crash leaves both or
  // neither.
  const register = Effect.fn("Projects.register")(function* (
    primaryPath: string,
  ) {
    const facts = yield* seedOf(primaryPath);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const project = yield* registry.register({
            name: path.basename(primaryPath),
            path: primaryPath,
          });
          yield* seed(project, facts);
          return project;
        }),
      )
      .pipe(Effect.catchTags({ SqlError: (error) => Effect.die(error) }));
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
      // One folder at a time: a wide tree can't run out of file handles,
      // which would read as folders with nothing in them.
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
