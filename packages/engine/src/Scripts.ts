import type { PackageScriptSortMode } from "@shigomori/contracts/schemas/scripts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { type PackageScript, packageScripts } from "./packageJson.ts";
import * as Usage from "./Usage.ts";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

// What the scripts panel reads for one worktree: its package.json
// scripts in manifest order, the manager its lockfile picks, each
// script's use stats, and the project's sort and manual order.
export type PackageScriptsList = {
  readonly packageManager: PackageManager;
  readonly scripts: ReadonlyArray<PackageScript>;
  readonly usage: Readonly<Record<string, Usage.UseStat>>;
  // A PackageScriptSortMode, or a mode a newer build stored.
  readonly sort: string;
  readonly order: ReadonlyArray<string>;
};

// The panel reads this as "no scripts", not as a failure.
export class NoPackageJson extends Schema.TaggedError<NoPackageJson>()(
  "NoPackageJson",
  { dir: Schema.String },
) {
  override get message(): string {
    return `No package.json in ${this.dir}.`;
  }
}

// A package.json that can't be read (permissions, a directory), or that
// isn't a JSON object.
export class UnreadablePackageJson extends Schema.TaggedError<UnreadablePackageJson>()(
  "UnreadablePackageJson",
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

export class Scripts extends Context.Service<
  Scripts,
  {
    readonly list: (input: {
      readonly projectId: string;
      readonly worktreePath: string;
    }) => Effect.Effect<
      PackageScriptsList,
      NoPackageJson | UnreadablePackageJson
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

  const list = Effect.fn("Scripts.list")(function* (input: {
    readonly projectId: string;
    readonly worktreePath: string;
  }) {
    const manifest = path.join(input.worktreePath, "package.json");
    const text = yield* fs.readFileString(manifest).pipe(
      Effect.mapError((cause) =>
        Predicate.isTagged(cause.reason, "NotFound")
          ? new NoPackageJson({ dir: input.worktreePath })
          : new UnreadablePackageJson({
              path: manifest,
              stage: "read",
              cause,
            }),
      ),
    );
    const scripts = yield* Effect.try({
      try: () => packageScripts(text),
      catch: (cause) =>
        new UnreadablePackageJson({ path: manifest, stage: "parse", cause }),
    });
    const { manager, stats, sorted, order } = yield* Effect.all(
      {
        manager: packageManager(input.worktreePath),
        stats: usage.stats("script", input.projectId),
        sorted: sql<{ mode: string }>`SELECT mode FROM script_sort
          WHERE project_id = ${input.projectId}`,
        order: storedList(input.projectId, "order"),
      },
      { concurrency: "unbounded" },
    ).pipe(Effect.catchTags({ SqlError: Effect.die }));
    return {
      packageManager: manager,
      scripts,
      usage: Object.fromEntries(
        scripts.map(({ name }) => [
          name,
          stats.get(name) ?? { lastUsed: 0, recentCount: 0 },
        ]),
      ),
      // A mode a newer build stored is passed on, and an empty one is
      // the default.
      sort: sorted[0]?.mode || IMPLICIT_SORT,
      order,
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
    recordRun,
    setSort,
    arrange,
    launchRow,
    setOnLaunchRow,
  });
});

export const layer = Layer.effect(Scripts, make);
