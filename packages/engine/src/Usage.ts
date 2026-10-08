import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

// The use logs the sorts rank by: a project's actions, a launcher's
// opens, a package script's runs. A use older than the window still
// counts as the last use. Only the count is windowed.
export type UseLog = "project" | "launcher" | "script";

export type UseStat = {
  // The newest use in epoch ms, 0 for never.
  readonly lastUsed: number;
  // Uses within the window.
  readonly recentCount: number;
};

export const USE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export class Usage extends Context.Service<
  Usage,
  {
    // Counts a use now, dropping the name's uses older than the window.
    // `scope` is the project id for project and script uses, empty for
    // a launcher.
    readonly record: (
      log: UseLog,
      scope: string,
      name: string,
    ) => Effect.Effect<void>;
    // Each name's stats in a scope.
    readonly stats: (
      log: UseLog,
      scope: string,
    ) => Effect.Effect<ReadonlyMap<string, UseStat>>;
    // One name's stats in every scope, by scope: each project's own
    // uses, say.
    readonly statsByScope: (
      log: UseLog,
      name: string,
    ) => Effect.Effect<ReadonlyMap<string, UseStat>>;
  }
>()("sm/engine/Usage") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const record = Effect.fn("Usage.record")(function* (
    log: UseLog,
    scope: string,
    name: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* sql.withTransaction(
      Effect.all([
        sql`DELETE FROM usage WHERE log = ${log} AND scope = ${scope}
            AND name = ${name} AND at < ${now - USE_WINDOW_MS}`,
        sql`INSERT INTO usage ${sql.insert({ log, scope, name, at: now })}`,
      ]),
    );
  }, Effect.orDie);

  // Each group's newest use and its uses within the window.
  const grouped = (log: UseLog, by: "name" | "scope", within: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* sql<{
        key: string;
        lastUsed: number;
        recentCount: number;
      }>`SELECT ${sql(by)} AS key, max(at) AS lastUsed,
            count(CASE WHEN at >= ${now - USE_WINDOW_MS} THEN 1 END) AS recentCount
          FROM usage WHERE log = ${log}
            AND ${sql(by === "name" ? "scope" : "name")} = ${within}
          GROUP BY ${sql(by)}`;
      return new Map(
        rows.map(({ key, lastUsed, recentCount }) => [
          key,
          { lastUsed, recentCount },
        ]),
      );
    }).pipe(Effect.orDie);

  const stats = Effect.fn("Usage.stats")(function* (
    log: UseLog,
    scope: string,
  ) {
    return yield* grouped(log, "name", scope);
  });

  const statsByScope = Effect.fn("Usage.statsByScope")(function* (
    log: UseLog,
    name: string,
  ) {
    return yield* grouped(log, "scope", name);
  });

  return Usage.of({ record, stats, statsByScope });
});

export const layer = Layer.effect(Usage, make);
