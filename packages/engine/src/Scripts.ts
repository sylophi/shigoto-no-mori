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
  readonly packageManager: PackageManager | "";
  readonly scripts: ReadonlyArray<PackageScript>;
  readonly usage: Readonly<Record<string, Usage.UseStat>>;
  readonly sort: PackageScriptSortMode;
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

export class UnreadablePackageJson extends Schema.TaggedError<UnreadablePackageJson>()(
  "UnreadablePackageJson",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.path} could not be read as JSON.`;
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

  const packageManager = Effect.fn(function* (dir: string) {
    if (!(yield* present(path.join(dir, "package.json")))) return "" as const;
    for (const [file, manager] of LOCKFILES) {
      if (yield* present(path.join(dir, file))) return manager;
    }
    return "npm" as const;
  });

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
    const text = yield* fs
      .readFileString(manifest)
      .pipe(
        Effect.mapError((cause) =>
          Predicate.isTagged(cause.reason, "NotFound")
            ? new NoPackageJson({ dir: input.worktreePath })
            : new UnreadablePackageJson({ path: manifest, cause }),
        ),
      );
    const scripts = yield* Effect.try({
      try: () => packageScripts(text),
      catch: (cause) => new UnreadablePackageJson({ path: manifest, cause }),
    });
    const stats = yield* usage.stats("script", input.projectId);
    const [sorted] = yield* Effect.orDie(
      sql<{ mode: PackageScriptSortMode }>`SELECT mode FROM script_sort
        WHERE project_id = ${input.projectId}`,
    );
    return {
      packageManager: yield* packageManager(input.worktreePath),
      scripts,
      usage: Object.fromEntries(
        scripts.map(({ name }) => [
          name,
          stats.get(name) ?? { lastUsed: 0, recentCount: 0 },
        ]),
      ),
      sort: sorted?.mode ?? IMPLICIT_SORT,
      order: yield* Effect.orDie(storedList(input.projectId, "order")),
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
