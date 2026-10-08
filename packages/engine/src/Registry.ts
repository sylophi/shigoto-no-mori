import type { ProjectRow } from "@shigomori/contracts/schemas/project";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Icons from "./Icons.ts";
import * as Identity from "./Identity.ts";
import * as Terrier from "./Terrier.ts";
import { terrierProjects } from "./Terrier.ts";
import { terrierProjectId } from "./terrierId.ts";
import * as Usage from "./Usage.ts";
import { worktreeIdFromPath } from "./worktreeLayout.ts";

// A project as the registry holds it.
export type RegisteredProject = {
  readonly id: string;
  readonly name: string;
  readonly path: string;
};

// The marks a worktree can carry, keyed by its path-derived id.
export type WorktreeMark = "shelved" | "autoPull" | "agentWorking";

export class ProjectAlreadyAdded extends Schema.TaggedError<ProjectAlreadyAdded>()(
  "ProjectAlreadyAdded",
  { path: Schema.String },
) {
  override get message(): string {
    return `Project already added: ${this.path}`;
  }
}

export class UnknownProject extends Schema.TaggedError<UnknownProject>()(
  "UnknownProject",
  { projectId: Schema.String },
) {
  override get message(): string {
    return `Unknown project: ${this.projectId}`;
  }
}

// Another registered project already sits at the path.
export class ProjectPathTaken extends Schema.TaggedError<ProjectPathTaken>()(
  "ProjectPathTaken",
  { path: Schema.String, name: Schema.String },
) {
  override get message(): string {
    return `${this.path} is already registered as ${this.name}`;
  }
}

// A listed project: the registry's, or terrier's (read-only).
export type ListedProject = RegisteredProject & {
  readonly source?: "terrier";
};

export class Registry extends Context.Service<
  Registry,
  {
    // The registered projects, in the order they were added.
    readonly projects: Effect.Effect<ReadonlyArray<RegisteredProject>>;
    // Every project the device lists, in the manual order: the
    // registry's, then terrier's while that integration is on.
    readonly listed: Effect.Effect<ReadonlyArray<ListedProject>>;
    // The rows the sidebar shows, in the manual order: each project
    // with whether its folder is there, its identity and remote, its use
    // stats and its icon. The hue is always null (V3.md, decision 12).
    // `rescanIconMisses` looks again for icons of projects remembered as
    // having none.
    readonly rows: (options?: {
      readonly rescanIconMisses?: boolean;
    }) => Effect.Effect<ReadonlyArray<ProjectRow>>;
    // Adds a project under a new id, or under its terrier id when
    // terrier lists the path, so its state carries over.
    readonly register: (input: {
      readonly name: string;
      readonly path: string;
    }) => Effect.Effect<RegisteredProject, ProjectAlreadyAdded>;
    // Drops the entry and the project's settings and worktree data.
    readonly unregister: (
      projectId: string,
    ) => Effect.Effect<RegisteredProject, UnknownProject>;
    // Points the entry at where its repo is now, under the new folder's
    // name, keeping its id: its place in the manual order moves with it,
    // and the icon remembered for the old path goes.
    readonly relocate: (
      projectId: string,
      path: string,
      name: string,
    ) => Effect.Effect<RegisteredProject, UnknownProject | ProjectPathTaken>;
    // The sidebar's manual order, as project paths.
    readonly order: Effect.Effect<ReadonlyArray<string>>;
    // Stores `listed` (the merged list as it reads now) with `ids` moved
    // to the front in their order. A stored path the list lacks keeps its
    // place behind the path it followed. False when nothing changed.
    readonly reorder: (
      listed: ReadonlyArray<RegisteredProject>,
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<boolean>;
    readonly marked: (mark: WorktreeMark) => Effect.Effect<ReadonlySet<string>>;
    readonly setMark: (
      mark: WorktreeMark,
      worktreeId: string,
      on: boolean,
    ) => Effect.Effect<void>;
    // Clears what is kept under an id that is going away.
    readonly forgetWorktree: (worktreeId: string) => Effect.Effect<void>;
    // Carries the marks of a moved checkout to its new id. The shelf
    // snapshot stays behind: a move can give every file a fresh mtime.
    readonly moveWorktree: (from: string, to: string) => Effect.Effect<void>;
    // The id this data dir goes by, minted on first ask.
    readonly deviceId: Effect.Effect<string>;
  }
>()("sm/engine/Registry") {}

// The stored order over a list: the projects it names first, in its
// order, then the rest in list order.
export function orderProjects<P extends { readonly path: string }>(
  projects: ReadonlyArray<P>,
  order: ReadonlyArray<string>,
): ReadonlyArray<P> {
  const rank = new Map<string, number>();
  order.forEach((path, index) => {
    if (!rank.has(path)) rank.set(path, index);
  });
  const rankOf = (project: P) => rank.get(project.path) ?? order.length;
  return projects.toSorted((a, b) => rankOf(a) - rankOf(b));
}

// The paths `stored` holds and `order` doesn't, each put back behind the
// path it followed (first when it followed none).
export function keepUnlisted(
  order: ReadonlyArray<string>,
  stored: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const next = [...order];
  const placed = new Set(order);
  let previous: string | undefined;
  for (const path of stored) {
    if (!placed.has(path)) {
      next.splice(
        previous === undefined ? 0 : next.indexOf(previous) + 1,
        0,
        path,
      );
      placed.add(path);
    }
    previous = path;
  }
  return next;
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const identity = yield* Identity.Identity;
  const icons = yield* Icons.Icons;
  const terrier = yield* Terrier.Terrier;
  const usage = yield* Usage.Usage;
  const crypto = yield* Crypto.Crypto;
  const randomId = Effect.orDie(crypto.randomUUIDv4);

  const projects = sql<RegisteredProject>`
    SELECT id, name, path FROM projects ORDER BY position`.pipe(
    Effect.map((rows) =>
      rows.map(({ id, name, path }) => ({ id, name, path })),
    ),
    Effect.orDie,
    Effect.withSpan("Registry.projects"),
  );

  const register = Effect.fn("Registry.register")(function* (input: {
    readonly name: string;
    readonly path: string;
  }) {
    const terrierLists = (yield* terrier.listing).paths.includes(input.path);
    const project = {
      id: terrierLists
        ? terrierProjectId(input.path)
        : (yield* randomId).toUpperCase(),
      name: input.name,
      path: input.path,
    };
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [taken] =
            yield* sql`SELECT 1 FROM projects WHERE path = ${input.path}`;
          if (taken)
            return yield* new ProjectAlreadyAdded({ path: input.path });
          yield* sql`INSERT INTO projects (id, name, path, position)
          SELECT ${project.id}, ${project.name}, ${project.path},
            coalesce(max(position) + 1, 0) FROM projects`;
        }),
      )
      .pipe(Effect.catchTags({ SqlError: Effect.die }));
    return project;
  });

  const unregister = Effect.fn("Registry.unregister")(function* (
    projectId: string,
  ) {
    const stillListed = (yield* terrier.listing).paths;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [project] = yield* sql<RegisteredProject>`
          SELECT id, name, path FROM projects WHERE id = ${projectId}`;
          if (!project) return yield* new UnknownProject({ projectId });
          yield* sql`DELETE FROM projects WHERE id = ${projectId}`;
          // A project terrier still lists stays, under its terrier id,
          // and keeps its settings and worktree data there.
          if (stillListed.includes(project.path)) {
            const kept = terrierProjectId(project.path);
            if (kept !== projectId) {
              yield* sql`DELETE FROM project_config WHERE project_id = ${kept}`;
              yield* sql`DELETE FROM worktree_data WHERE project_id = ${kept}`;
              yield* sql`UPDATE project_config SET project_id = ${kept}
                WHERE project_id = ${projectId}`;
              yield* sql`UPDATE worktree_data SET project_id = ${kept}
                WHERE project_id = ${projectId}`;
            }
            return { id: project.id, name: project.name, path: project.path };
          }
          yield* sql`DELETE FROM project_config WHERE project_id = ${projectId}`;
          yield* sql`DELETE FROM worktree_data WHERE project_id = ${projectId}`;
          // What is kept by the project's path, which would greet a
          // re-add: its place in the order, its primary's marks, its icon.
          yield* sql`DELETE FROM project_order WHERE path = ${project.path}`;
          const primary = worktreeIdFromPath(project.path);
          yield* sql`DELETE FROM worktree_marks WHERE worktree_id = ${primary}`;
          yield* sql`DELETE FROM shelf_snapshots WHERE worktree_id = ${primary}`;
          yield* sql`DELETE FROM icon_cache WHERE project_path = ${project.path}`;
          return { id: project.id, name: project.name, path: project.path };
        }),
      )
      .pipe(Effect.catchTags({ SqlError: Effect.die }));
  });

  const order = sql<{ path: string }>`
    SELECT path FROM project_order ORDER BY position`.pipe(
    Effect.map((rows) => rows.map(({ path }) => path)),
    Effect.orDie,
    Effect.withSpan("Registry.order"),
  );

  const reorder = Effect.fn("Registry.reorder")(function* (
    listed: ReadonlyArray<RegisteredProject>,
    ids: ReadonlyArray<string>,
  ) {
    const pathOf = new Map(listed.map((project) => [project.id, project.path]));
    const next = orderProjects(
      listed,
      ids.flatMap((id) => {
        const path = pathOf.get(id);
        return path === undefined ? [] : [path];
      }),
    );
    if (next.every((project, index) => project.id === listed[index]?.id)) {
      return false;
    }
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const stored = yield* order;
        const paths = keepUnlisted(
          next.map((project) => project.path),
          stored,
        );
        yield* sql`DELETE FROM project_order`;
        yield* sql`INSERT INTO project_order ${sql.insert(
          paths.map((path, position) => ({ path, position })),
        )}`;
      }),
    );
    return true;
  }, Effect.orDie);

  const listed = Effect.gen(function* () {
    const registered = yield* projects;
    const extras = terrierProjects(
      new Set(registered.map(({ path }) => path)),
      (yield* terrier.listing).paths,
    );
    return orderProjects<ListedProject>(
      [...registered, ...extras],
      yield* order,
    );
  }).pipe(Effect.withSpan("Registry.listed"));

  const rows = Effect.fn("Registry.rows")(function* (options?: {
    readonly rescanIconMisses?: boolean;
  }) {
    const all = yield* listed;
    const uses = yield* usage.statsByScope("project", "");
    return yield* Effect.forEach(
      all,
      (project) =>
        Effect.gen(function* () {
          const stats = uses.get(project.id);
          const pathExists = yield* fs.stat(project.path).pipe(
            Effect.map((info) => info.type === "Directory"),
            Effect.orElseSucceed(() => false),
          );
          const [repo, icon] = pathExists
            ? yield* Effect.all(
                [
                  identity.of(project.path),
                  Effect.map(
                    icons.of(project.path, {
                      rescanMisses: options?.rescanIconMisses === true,
                    }),
                    Option.getOrNull,
                  ),
                ],
                { concurrency: 2 },
              )
            : [{ identity: null, remote: null }, null];
          return {
            ...project,
            pathExists,
            identity: repo.identity,
            remote: repo.remote,
            lastUsed: stats?.lastUsed ?? 0,
            recentCount: stats?.recentCount ?? 0,
            icon,
            hue: null,
          };
        }),
      { concurrency: "unbounded" },
    );
  });

  const marked = Effect.fn("Registry.marked")(function* (mark: WorktreeMark) {
    const found = yield* sql<{ worktree_id: string }>`
      SELECT worktree_id FROM worktree_marks WHERE mark = ${mark}`;
    return new Set(found.map(({ worktree_id }) => worktree_id));
  }, Effect.orDie);

  const setMark = Effect.fn("Registry.setMark")(function* (
    mark: WorktreeMark,
    worktreeId: string,
    on: boolean,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* on
          ? sql`INSERT INTO worktree_marks (worktree_id, mark)
                VALUES (${worktreeId}, ${mark}) ON CONFLICT DO NOTHING`
          : sql`DELETE FROM worktree_marks
                WHERE worktree_id = ${worktreeId} AND mark = ${mark}`;
        // A fresh shelf starts from a fresh snapshot.
        if (mark === "shelved") {
          yield* sql`DELETE FROM shelf_snapshots WHERE worktree_id = ${worktreeId}`;
        }
      }),
    );
  }, Effect.orDie);

  const forgetWorktree = Effect.fn("Registry.forgetWorktree")(function* (
    worktreeId: string,
  ) {
    yield* sql`DELETE FROM worktree_marks WHERE worktree_id = ${worktreeId}`;
    yield* sql`DELETE FROM shelf_snapshots WHERE worktree_id = ${worktreeId}`;
  }, Effect.orDie);

  const moveWorktree = Effect.fn("Registry.moveWorktree")(function* (
    from: string,
    to: string,
  ) {
    yield* sql.withTransaction(
      Effect.all([
        sql`DELETE FROM worktree_marks WHERE worktree_id = ${to}
            AND mark IN (SELECT mark FROM worktree_marks WHERE worktree_id = ${from})`,
        sql`UPDATE worktree_marks SET worktree_id = ${to} WHERE worktree_id = ${from}`,
        sql`DELETE FROM shelf_snapshots WHERE worktree_id = ${from}`,
      ]),
    );
  }, Effect.orDie);

  // A stored id that isn't UUID-shaped is replaced, inside one
  // transaction so two processes on a fresh data dir settle on one.
  const deviceId = sql
    .withTransaction(
      Effect.gen(function* () {
        const [stored] = yield* sql<{ device_id: string }>`
        SELECT device_id FROM device WHERE id = 1`;
        if (stored && UUID_SHAPE.test(stored.device_id))
          return stored.device_id;
        const minted = yield* randomId;
        yield* sql`INSERT INTO device (id, device_id) VALUES (1, ${minted})
        ON CONFLICT (id) DO UPDATE SET device_id = excluded.device_id`;
        return minted;
      }),
    )
    .pipe(Effect.orDie, Effect.withSpan("Registry.deviceId"));

  const relocate = Effect.fn("Registry.relocate")(function* (
    projectId: string,
    path: string,
    name: string,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const [project] = yield* sql<RegisteredProject>`
            SELECT id, name, path FROM projects WHERE id = ${projectId}`;
          if (!project) return yield* new UnknownProject({ projectId });
          const [other] = yield* sql<{ name: string }>`
            SELECT name FROM projects WHERE path = ${path} AND id != ${projectId}`;
          if (other) {
            return yield* new ProjectPathTaken({ path, name: other.name });
          }
          yield* sql`UPDATE projects SET name = ${name}, path = ${path}
            WHERE id = ${projectId}`;
          // In the project's own place, and only there: the new path may
          // already hold one (kept for a terrier row, say).
          const [placed] = yield* sql`
            SELECT 1 FROM project_order WHERE path = ${project.path}`;
          if (placed) {
            yield* sql`DELETE FROM project_order WHERE path = ${path}`;
            yield* sql`UPDATE project_order SET path = ${path}
              WHERE path = ${project.path}`;
          }
          yield* sql`DELETE FROM icon_cache WHERE project_path = ${project.path}`;
          return { id: projectId, name, path };
        }),
      )
      .pipe(Effect.catchTags({ SqlError: Effect.die }));
  });

  return Registry.of({
    projects,
    relocate,
    listed,
    rows,
    register,
    unregister,
    order,
    reorder,
    marked,
    setMark,
    forgetWorktree,
    moveWorktree,
    deviceId,
  });
});

export const layer = Layer.effect(Registry, make);
