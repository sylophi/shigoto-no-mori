// What the engine keeps about one worktree beyond git: the title and
// description `sm describe` set, and the ports the user added. Keyed by
// the project and the worktree's path-derived id, so a move re-keys it
// and a removal drops it.
import {
  type CustomPort,
  CustomPortSchema,
  MAX_CUSTOM_PORTS,
} from "@shigomori/contracts/schemas/ports";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// A worktree's title and description, empty when unset. `describedAt`
// (epoch ms, 0 for never) is when either was last set: a mirror's two
// sides each take describes, and the newer pair is the one both keep.
export type Description = {
  readonly title: string;
  readonly description: string;
  readonly describedAt: number;
};

export class WorktreeData extends Context.Service<
  WorktreeData,
  {
    readonly description: (
      projectId: string,
      worktreeId: string,
    ) => Effect.Effect<Description>;
    // Sets what `change` names from the pair as stored when the write
    // lands, so a describe in between isn't undone, and stamps the time.
    // An empty value clears its field. Answers what it wrote.
    readonly describe: (
      projectId: string,
      worktreeId: string,
      change: { readonly title?: string; readonly description?: string },
    ) => Effect.Effect<Description>;
    // A pair described elsewhere (the worktree's copy on another
    // device), stored with its own time when it was described after the
    // pair stored here, so a carry that read a stale side can't undo a
    // newer describe. Answers whether it landed.
    readonly carry: (
      projectId: string,
      worktreeId: string,
      described: Description,
    ) => Effect.Effect<boolean>;
    // The ports the user added beside port-pool's, empty when none.
    readonly ports: (
      projectId: string,
      worktreeId: string,
    ) => Effect.Effect<ReadonlyArray<CustomPort>>;
    // Replaces them, the title and description kept. Labels are stored
    // trimmed. Ports the schema refuses are a defect, the transport
    // having decoded them already.
    readonly setPorts: (
      projectId: string,
      worktreeId: string,
      ports: ReadonlyArray<CustomPort>,
    ) => Effect.Effect<void>;
    // Carries what is kept under one id to another, the checkout having
    // moved. Whatever the new id held is replaced.
    readonly move: (
      projectId: string,
      from: string,
      to: string,
    ) => Effect.Effect<void>;
    // Drops what is kept under an id that is going away.
    readonly forget: (
      projectId: string,
      worktreeId: string,
    ) => Effect.Effect<void>;
    // Drops what is kept for every worktree of a project.
    readonly forgetProject: (projectId: string) => Effect.Effect<void>;
    // Every project and worktree id something is kept under.
    readonly kept: Effect.Effect<
      ReadonlyArray<{ readonly projectId: string; readonly worktreeId: string }>
    >;
  }
>()("sm/engine/WorktreeData") {}

export const NO_DESCRIPTION: Description = {
  title: "",
  description: "",
  describedAt: 0,
};

type Row = {
  readonly title: string | null;
  readonly description: string | null;
  readonly described_at: number | null;
};

const descriptionOf = (row: Row | undefined): Description =>
  row === undefined
    ? NO_DESCRIPTION
    : {
        title: row.title ?? "",
        description: row.description ?? "",
        describedAt: row.described_at ?? 0,
      };

const orNull = (value: string) => (value === "" ? null : value);

const PortsSchema = Schema.Array(CustomPortSchema).check(
  Schema.isMaxLength(MAX_CUSTOM_PORTS),
);
const PortsText = Schema.fromJsonString(PortsSchema);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const read = (projectId: string, worktreeId: string) =>
    sql<Row>`SELECT title, description, described_at FROM worktree_data
      WHERE project_id = ${projectId} AND worktree_id = ${worktreeId}`.pipe(
      Effect.map(([row]) => descriptionOf(row)),
    );

  const description = (projectId: string, worktreeId: string) =>
    read(projectId, worktreeId).pipe(
      Effect.orDie,
      Effect.withSpan("WorktreeData.description"),
    );

  const describe = Effect.fn("WorktreeData.describe")(function* (
    projectId: string,
    worktreeId: string,
    change: { readonly title?: string; readonly description?: string },
  ) {
    const now = yield* Clock.currentTimeMillis;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const stored = yield* read(projectId, worktreeId);
        const next = {
          title: change.title ?? stored.title,
          description: change.description ?? stored.description,
          describedAt: now,
        };
        yield* sql`INSERT INTO worktree_data ${sql.insert({
          project_id: projectId,
          worktree_id: worktreeId,
          title: orNull(next.title),
          description: orNull(next.description),
          described_at: next.describedAt,
        })} ON CONFLICT (project_id, worktree_id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          described_at = excluded.described_at`;
        return next;
      }),
    );
  }, Effect.orDie);

  const carry = Effect.fn("WorktreeData.carry")(function* (
    projectId: string,
    worktreeId: string,
    described: Description,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const stored = yield* read(projectId, worktreeId);
        if (described.describedAt <= stored.describedAt) return false;
        yield* sql`INSERT INTO worktree_data ${sql.insert({
          project_id: projectId,
          worktree_id: worktreeId,
          title: orNull(described.title),
          description: orNull(described.description),
          described_at: described.describedAt,
        })} ON CONFLICT (project_id, worktree_id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          described_at = excluded.described_at`;
        return true;
      }),
    );
  }, Effect.orDie);

  // A column that doesn't parse reads as none, as a data file that
  // didn't did.
  const ports = Effect.fn("WorktreeData.ports")(function* (
    projectId: string,
    worktreeId: string,
  ) {
    const [row] = yield* sql<{ ports: string | null }>`SELECT ports
      FROM worktree_data
      WHERE project_id = ${projectId} AND worktree_id = ${worktreeId}`;
    if (row === undefined || row.ports === null) return [];
    return Option.getOrElse(
      Schema.decodeOption(PortsText)(row.ports),
      () => [],
    );
  }, Effect.orDie);

  const setPorts = Effect.fn("WorktreeData.setPorts")(function* (
    projectId: string,
    worktreeId: string,
    added: ReadonlyArray<CustomPort>,
  ) {
    const decoded = yield* Schema.decodeEffect(PortsSchema)(added);
    yield* sql`INSERT INTO worktree_data ${sql.insert({
      project_id: projectId,
      worktree_id: worktreeId,
      ports: decoded.length === 0 ? null : JSON.stringify(decoded),
    })} ON CONFLICT (project_id, worktree_id) DO UPDATE SET
      ports = excluded.ports`;
  }, Effect.orDie);

  const move = Effect.fn("WorktreeData.move")(function* (
    projectId: string,
    from: string,
    to: string,
  ) {
    yield* sql.withTransaction(
      Effect.all([
        sql`DELETE FROM worktree_data
            WHERE project_id = ${projectId} AND worktree_id = ${to}`,
        sql`UPDATE worktree_data SET worktree_id = ${to}
            WHERE project_id = ${projectId} AND worktree_id = ${from}`,
      ]),
    );
  }, Effect.orDie);

  const forget = Effect.fn("WorktreeData.forget")(function* (
    projectId: string,
    worktreeId: string,
  ) {
    yield* sql`DELETE FROM worktree_data
      WHERE project_id = ${projectId} AND worktree_id = ${worktreeId}`;
  }, Effect.orDie);

  const kept = sql<{ project_id: string; worktree_id: string }>`
    SELECT project_id, worktree_id FROM worktree_data`.pipe(
    Effect.map((rows) =>
      rows.map(({ project_id, worktree_id }) => ({
        projectId: project_id,
        worktreeId: worktree_id,
      })),
    ),
    Effect.orDie,
    Effect.withSpan("WorktreeData.kept"),
  );

  const forgetProject = Effect.fn("WorktreeData.forgetProject")(function* (
    projectId: string,
  ) {
    yield* sql`DELETE FROM worktree_data WHERE project_id = ${projectId}`;
  }, Effect.orDie);

  return WorktreeData.of({
    description,
    describe,
    carry,
    ports,
    setPorts,
    move,
    forget,
    forgetProject,
    kept,
  });
});

export const layer = Layer.effect(WorktreeData, make);
