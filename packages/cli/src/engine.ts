// The engine under the terminal: the store over Bun's SQLite, and the
// darwin helper beside the binary.
import { dirname, join } from "node:path";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { flavorNames, type Flavor } from "@shigomori/engine/flavor";
import { doctorLayer, engineLayer } from "@shigomori/engine/layer";
import * as Migration from "@shigomori/engine/Migration";
import * as Store from "@shigomori/engine/Store";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { note } from "./output.ts";

const open: Store.OpenDatabase = (filename) => SqliteClient.make({ filename });
const macfs = join(dirname(process.execPath), "macfs");
// What the agent hooks run: this binary (Agents names it by its real
// path).
const sm = process.execPath;

type StoreMigration = Effect.Success<Migration.Migration["Service"]["current"]>;

const worktrees = (n: number) => `${n} ${n === 1 ? "worktree" : "worktrees"}`;

// The move's line, once it has ended.
const moveLine = (step: StoreMigration["worktrees"], binaryName: string) => {
  if (step === null || step.total === 0) return null;
  if (step.state === "done") return `Moved ${worktrees(step.moved)} into wt/.`;
  if (step.state !== "stuck") return null;
  const stayed = step.stuck
    .map(({ name, reason }) => `${name} (${reason})`)
    .join(", ");
  return `Moved ${step.moved} of ${worktrees(step.total)} into wt/; ${stayed} stayed, for \`${binaryName} doctor --fix\`.`;
};

// Each step's line, once it has ended.
const lines = (migration: StoreMigration, binaryName: string) => ({
  import:
    migration.import?.state === "done"
      ? "Imported the projects and settings from v2."
      : null,
  worktrees: moveLine(migration.worktrees, binaryName),
});

// The engine, the migration a first start makes said one line per step
// as each ends, all of it before the command runs.
export const engine = (flavor: Flavor) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const migration = yield* Migration.Migration;
      const { binaryName } = flavorNames(flavor);
      const told = new Set<string>();
      const telling = yield* migration.changes.pipe(
        Stream.takeUntil(Migration.finished),
        Stream.runForEach((value) =>
          Effect.forEach(
            Object.entries(lines(value, binaryName)),
            ([step, line]) => {
              if (line === null || told.has(step)) return Effect.void;
              told.add(step);
              return note(line);
            },
            { discard: true },
          ),
        ),
        Effect.forkScoped,
      );
      return Layer.effectDiscard(Fiber.join(telling)).pipe(
        Layer.provideMerge(
          engineLayer({ flavor, store: Store.layer(open), macfs, sm }),
        ),
      );
    }),
  ).pipe(Layer.provideMerge(Migration.layer));

// `sm doctor`'s, which opens the store inside each run, so a store that
// won't open still gets its checklist.
export const doctor = (flavor: Flavor) => doctorLayer({ flavor, open, macfs });
