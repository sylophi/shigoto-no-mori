import type { PackageScriptSortMode } from "@shigomori/contracts/schemas/scripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { findExecutable } from "./executables.ts";
import { packageScripts } from "./packageJson.ts";
import {
  findJustfile,
  findMakefile,
  findPackageJson,
  parseJustfile,
  parseMakefile,
  type Runner,
} from "./scriptFiles.ts";
import * as Usage from "./Usage.ts";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

// One script of a worktree's: package.json's by its own name, a
// justfile recipe as "just <recipe>" and a Makefile target as "make
// <target>". `file` is the file it comes from and `label` the name it
// goes by there ("build" for "just build").
export type Script = {
  readonly name: string;
  readonly command: string;
  readonly file: string;
  readonly label: string;
};

// A script as read, with the runner that runs a recipe or target
// (none for package.json's, which its manager runs).
type FoundScript = Script & { readonly runner: Runner | undefined };

// What the scripts panel reads for one worktree: its scripts in file
// order (package.json's, then the justfile's, then the Makefile's), the
// files they were read from, the manager its lockfile picks (none
// without a package.json), each script's use stats, and the project's
// sort and manual order.
export type ScriptsList = {
  readonly packageManager: PackageManager | null;
  readonly scripts: ReadonlyArray<Script>;
  readonly files: ReadonlyArray<string>;
  readonly usage: Readonly<Record<string, Usage.UseStat>>;
  // A PackageScriptSortMode, or a mode a newer build stored.
  readonly sort: string;
  readonly order: ReadonlyArray<string>;
};

// No package.json, justfile or Makefile. The panel reads this as "no
// scripts", not as a failure.
export class NoScripts extends Schema.TaggedError<NoScripts>()("NoScripts", {
  dir: Schema.String,
}) {
  override get message(): string {
    return `No package.json, justfile or Makefile in ${this.dir}.`;
  }
}

// A script file that can't be read (permissions, a directory), or a
// package.json that isn't a JSON object. Only when no other script file
// reads: one that does hides the failure.
export class UnreadableScripts extends Schema.TaggedError<UnreadableScripts>()(
  "UnreadableScripts",
  {
    path: Schema.String,
    stage: Schema.Literals(["read", "parse"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.stage === "read"
      ? `${this.path} could not be read.`
      : `${this.path} is not a JSON object.`;
  }
}

// A script `sm run` can't start: the worktree has none, none by that
// name, or the tool that runs it (the manager its lockfile picks, just
// or make) isn't on PATH.
export class ScriptRefused extends Schema.TaggedError<ScriptRefused>()(
  "ScriptRefused",
  {
    reason: Schema.Literals(["no-scripts", "unknown-script", "no-tool"]),
    script: Schema.String,
    // The worktree's path and name, its scripts and the files they come
    // from.
    dir: Schema.String,
    worktree: Schema.String,
    scripts: Schema.Array(Schema.String),
    files: Schema.Array(Schema.String),
    // The tool that runs the script, and whether the lockfile picked it.
    tool: Schema.String,
    byLockfile: Schema.Boolean,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "no-scripts":
        return `${this.files.join(", ")} in ${this.dir} has no scripts.`;
      case "unknown-script":
        return `No script named ${JSON.stringify(this.script)}. Scripts: ${this.scripts.join(", ")}.`;
      case "no-tool":
        return this.byLockfile
          ? `${this.tool} isn't on PATH (the ${this.worktree} lockfile selects it).`
          : `${this.tool} isn't on PATH.`;
    }
  }
}

export class Scripts extends Context.Service<
  Scripts,
  {
    readonly list: (input: {
      readonly projectId: string;
      readonly worktreePath: string;
    }) => Effect.Effect<ScriptsList, NoScripts | UnreadableScripts>;
    // The project's sort and manual order alone, which no worktree's
    // scripts are needed for.
    readonly arrangement: (projectId: string) => Effect.Effect<{
      readonly sort: string;
      readonly order: ReadonlyArray<string>;
    }>;
    // The command that runs the worktree's script `script` with `extra`
    // after it, the tool found on PATH: the manager its lockfile picks
    // for a package.json script, just or make for a recipe or target.
    // From a terminal a recipe can be named as two words (`just build`),
    // which takes the first of `extra`; `script` is the name it resolved
    // to.
    readonly command: (input: {
      readonly worktree: { readonly path: string; readonly name: string };
      readonly script: string;
      readonly extra: ReadonlyArray<string>;
    }) => Effect.Effect<
      {
        readonly program: string;
        readonly args: ReadonlyArray<string>;
        readonly script: string;
      },
      NoScripts | UnreadableScripts | ScriptRefused
    >;
    // The scripts at the root of `dir`, in file order, and the files
    // they were read from.
    readonly readScripts: (dir: string) => Effect.Effect<
      {
        readonly scripts: ReadonlyArray<Script>;
        readonly files: ReadonlyArray<string>;
      },
      NoScripts | UnreadableScripts
    >;
    // Counts a run of the project's script.
    readonly recordRun: (
      projectId: string,
      script: string,
    ) => Effect.Effect<void>;
    readonly setSort: (
      projectId: string,
      mode: PackageScriptSortMode,
    ) => Effect.Effect<void>;
    // One worktree's scripts in their new order. Scripts it lacks
    // (another branch's) stay stored, each right behind the nearest
    // script it followed that this worktree has.
    readonly arrange: (
      projectId: string,
      arranged: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
    // The manager the folder's lockfile picks, none without a
    // package.json.
    readonly packageManager: (
      dir: string,
    ) => Effect.Effect<Option.Option<PackageManager>>;
    // The scripts put on the launch row by hand.
    readonly launchRow: (
      projectId: string,
    ) => Effect.Effect<ReadonlyArray<string>>;
    readonly setOnLaunchRow: (
      projectId: string,
      script: string,
      onRow: boolean,
    ) => Effect.Effect<void>;
  }
>()("sm/engine/Scripts") {}

// The sort a project without a saved one uses: most used first.
const IMPLICIT_SORT = "frequent";

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

// npm only passes arguments on to the script after `--`. pnpm, yarn and
// bun pass bare ones themselves.
const runArgs = (
  manager: PackageManager,
  script: string,
  extra: ReadonlyArray<string>,
) => [
  "run",
  script,
  ...(extra.length > 0 && manager === "npm" ? ["--"] : []),
  ...extra,
];

// The script the positionals name and the args left for it. A script
// is named whole ("just build" is one argument from the app), or, typed
// in a terminal, as `sm run just build`: the runner and the recipe as
// two words, unless package.json has a script called "just" itself.
export function findScript<
  S extends { readonly name: string; readonly runner: Runner | undefined },
>(
  scripts: ReadonlyArray<S>,
  positionals: ReadonlyArray<string>,
): { readonly script: S; readonly extra: ReadonlyArray<string> } | undefined {
  const [first, second] = positionals;
  const whole = scripts.find(({ name }) => name === first);
  if (whole !== undefined)
    return { script: whole, extra: positionals.slice(1) };
  if (second === undefined) return undefined;
  const split = scripts.find(({ name }) => name === `${first} ${second}`);
  return split?.runner === undefined
    ? undefined
    : { script: split, extra: positionals.slice(2) };
}

const publicScript = ({ name, command, file, label }: FoundScript): Script => ({
  name,
  command,
  file,
  label,
});

export function mergeArrangedOrder(
  stored: ReadonlyArray<string>,
  arranged: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const shown = new Set(arranged);
  const followers = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const name of stored) {
    if (shown.has(name)) {
      anchor = name;
    } else {
      followers.set(anchor, [...(followers.get(anchor) ?? []), name]);
    }
  }
  return [
    ...(followers.get(null) ?? []),
    ...arranged.flatMap((name) => [name, ...(followers.get(name) ?? [])]),
  ];
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const usage = yield* Usage.Usage;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  // Whether the entry is there, a dangling symlink included.
  const present = (file: string) =>
    fs.exists(file).pipe(
      Effect.flatMap((exists) =>
        exists ? Effect.succeed(true) : fs.readLink(file).pipe(Effect.as(true)),
      ),
      Effect.orElseSucceed(() => false),
    );

  // The manager a package.json's lockfile picks, npm without one.
  const packageManager = (dir: string) =>
    Effect.forEach(LOCKFILES, ([file]) => present(path.join(dir, file)), {
      concurrency: "unbounded",
    }).pipe(
      Effect.map(
        (found) =>
          LOCKFILES.find((_, index) => found[index])?.[1] ?? ("npm" as const),
      ),
    );

  // The manager, none without a package.json.
  const packageManagerOf = (dir: string) =>
    present(path.join(dir, "package.json")).pipe(
      Effect.flatMap((found) =>
        found ? Effect.asSome(packageManager(dir)) : Effect.succeedNone,
      ),
    );

  const storedList = (projectId: string, listName: "order" | "launchRow") =>
    sql<{ name: string }>`SELECT name FROM script_lists
      WHERE project_id = ${projectId} AND list = ${listName}
      ORDER BY position`.pipe(
      Effect.map((rows) => rows.map(({ name }) => name)),
    );

  const storeList = (
    projectId: string,
    listName: "order" | "launchRow",
    names: ReadonlyArray<string>,
  ) =>
    Effect.all([
      sql`DELETE FROM script_lists
          WHERE project_id = ${projectId} AND list = ${listName}`,
      names.length === 0
        ? Effect.void
        : sql`INSERT INTO script_lists ${sql.insert(
            names.map((name, position) => ({
              project_id: projectId,
              list: listName,
              position,
              name,
            })),
          )}`,
    ]);

  // The parsers by file, package.json's first. Only package.json's can
  // fail: the others take any text.
  const sources: ReadonlyArray<{
    readonly find: (files: ReadonlyArray<string>) => string | undefined;
    readonly parse: (text: string) => ReadonlyArray<Omit<FoundScript, "file">>;
  }> = [
    {
      find: findPackageJson,
      parse: (text) =>
        packageScripts(text).map(({ name, command }) => ({
          name,
          command,
          label: name,
          runner: undefined,
        })),
    },
    { find: findJustfile, parse: parseJustfile },
    { find: findMakefile, parse: parseMakefile },
  ];

  // Every script the root of `dir` offers, package.json's first, then
  // the justfile's recipes and the Makefile's targets, and the files
  // they came from. A file that doesn't read or parse (a package.json
  // caught mid-edit) is left out rather than hiding the others, and
  // fails the read only when no other file is there.
  const readFound = Effect.fn("Scripts.readScripts")(function* (dir: string) {
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(
        Effect.mapError(
          (cause) => new UnreadableScripts({ path: dir, stage: "read", cause }),
        ),
      );
    const read = yield* Effect.forEach(
      sources,
      ({ find, parse }) =>
        Effect.gen(function* () {
          const file = find(entries);
          if (file === undefined) return undefined;
          const at = path.join(dir, file);
          // A directory by the name is no script file.
          const info = yield* fs.stat(at).pipe(Effect.option);
          if (Option.isSome(info) && info.value.type === "Directory") {
            return undefined;
          }
          return yield* fs.readFileString(at).pipe(
            Effect.mapError(
              (cause) =>
                new UnreadableScripts({ path: at, stage: "read", cause }),
            ),
            Effect.flatMap((text) =>
              Effect.try({
                try: () =>
                  parse(text).map(({ name, command, label, runner }) => ({
                    name,
                    command,
                    file,
                    label,
                    runner,
                  })),
                catch: (cause) =>
                  new UnreadableScripts({ path: at, stage: "parse", cause }),
              }),
            ),
            Effect.map((scripts) => ({ file, scripts })),
            Effect.result,
          );
        }),
      { concurrency: "unbounded" },
    );
    const found = read.filter(Predicate.isNotUndefined);
    const files = found.flatMap((result) =>
      Result.isSuccess(result) ? [result.success] : [],
    );
    if (files.length === 0) {
      const failure = found.find(Result.isFailure);
      return yield* failure === undefined
        ? new NoScripts({ dir })
        : failure.failure;
    }
    return {
      scripts: files.flatMap(({ scripts }) => scripts),
      files: files.map(({ file }) => file),
    };
  });

  const readScripts = (dir: string) =>
    readFound(dir).pipe(
      Effect.map(({ scripts, files }) => ({
        scripts: scripts.map(publicScript),
        files,
      })),
    );

  // A mode a newer build stored is passed on, and an empty one is the
  // default.
  const arrangement = Effect.fn("Scripts.arrangement")(function* (
    projectId: string,
  ) {
    const { sorted, order } = yield* Effect.all(
      {
        sorted: sql<{ mode: string }>`SELECT mode FROM script_sort
          WHERE project_id = ${projectId}`,
        order: storedList(projectId, "order"),
      },
      { concurrency: "unbounded" },
    );
    return { sort: sorted[0]?.mode || IMPLICIT_SORT, order };
  }, Effect.orDie);

  const list = Effect.fn("Scripts.list")(function* (input: {
    readonly projectId: string;
    readonly worktreePath: string;
  }) {
    const { scripts, files } = yield* readScripts(input.worktreePath);
    const { manager, stats, arranged } = yield* Effect.all(
      {
        manager: packageManagerOf(input.worktreePath),
        stats: usage.stats("script", input.projectId),
        arranged: arrangement(input.projectId),
      },
      { concurrency: "unbounded" },
    );
    return {
      packageManager: Option.getOrNull(manager),
      scripts,
      files,
      usage: Object.fromEntries(
        scripts.map(({ name }) => [
          name,
          stats.get(name) ?? { lastUsed: 0, recentCount: 0 },
        ]),
      ),
      ...arranged,
    };
  });

  const command = Effect.fn("Scripts.command")(function* (input: {
    readonly worktree: { readonly path: string; readonly name: string };
    readonly script: string;
    readonly extra: ReadonlyArray<string>;
  }) {
    const { scripts, files } = yield* readFound(input.worktree.path);
    const manager = yield* packageManager(input.worktree.path);
    const refused = (
      reason: ScriptRefused["reason"],
      tool: { readonly name: string; readonly byLockfile: boolean } = {
        name: manager,
        byLockfile: true,
      },
    ) =>
      new ScriptRefused({
        reason,
        script: input.script,
        dir: input.worktree.path,
        worktree: input.worktree.name,
        scripts: scripts.map(({ name }) => name),
        files,
        tool: tool.name,
        byLockfile: tool.byLockfile,
      });
    const found = findScript(scripts, [input.script, ...input.extra]);
    if (found === undefined) {
      return yield* refused(
        scripts.length === 0 ? "no-scripts" : "unknown-script",
      );
    }
    const { script, extra } = found;
    const tool = script.runner ?? manager;
    const program = yield* findExecutable(tool);
    if (Option.isNone(program)) {
      return yield* refused("no-tool", {
        name: tool,
        byLockfile: script.runner === undefined,
      });
    }
    return {
      // An empty or relative PATH entry is the cwd's, and the script
      // runs elsewhere.
      program: path.resolve(program.value),
      args:
        script.runner === undefined
          ? runArgs(manager, script.name, extra)
          : [script.label, ...extra],
      script: script.name,
    };
  });

  const recordRun = Effect.fn("Scripts.recordRun")(function* (
    projectId: string,
    script: string,
  ) {
    yield* usage.record("script", projectId, script);
  });

  const setSort = Effect.fn("Scripts.setSort")(function* (
    projectId: string,
    mode: PackageScriptSortMode,
  ) {
    yield* mode === IMPLICIT_SORT
      ? sql`DELETE FROM script_sort WHERE project_id = ${projectId}`
      : sql`INSERT INTO script_sort (project_id, mode) VALUES (${projectId}, ${mode})
            ON CONFLICT (project_id) DO UPDATE SET mode = excluded.mode`;
  }, Effect.orDie);

  const arrange = Effect.fn("Scripts.arrange")(function* (
    projectId: string,
    arranged: ReadonlyArray<string>,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const stored = yield* storedList(projectId, "order");
        yield* storeList(
          projectId,
          "order",
          mergeArrangedOrder(stored, arranged),
        );
      }),
    );
  }, Effect.orDie);

  const launchRow = Effect.fn("Scripts.launchRow")(function* (
    projectId: string,
  ) {
    return yield* storedList(projectId, "launchRow");
  }, Effect.orDie);

  const setOnLaunchRow = Effect.fn("Scripts.setOnLaunchRow")(function* (
    projectId: string,
    script: string,
    onRow: boolean,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const row = yield* storedList(projectId, "launchRow");
        if (row.includes(script) === onRow) return;
        yield* storeList(
          projectId,
          "launchRow",
          onRow ? [...row, script] : row.filter((name) => name !== script),
        );
      }),
    );
  }, Effect.orDie);

  return Scripts.of({
    list,
    arrangement,
    packageManager: packageManagerOf,
    command: (input) => command(input).pipe(Effect.provideContext(platform)),
    readScripts,
    recordRun,
    setSort,
    arrange,
    launchRow,
    setOnLaunchRow,
  });
});

export const layer = Layer.effect(Scripts, make);
