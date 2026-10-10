// A worktree's ports (packages/contracts/src/modules/ports.ts):
// port-pool's allocation for the directory when the integration is on,
// then the user-added entries from the worktree's data, each probed
// on this machine's loopback.
//
// The user's port-pool tool keeps its per-project config at
// <project-or-worktree-root>/port-pool.config.json and its allocations
// at $XDG_DATA_HOME/port-pool/state.json (~/.local/share when unset).
// The integration is on for a directory when the global toggle is, the
// binary is on PATH, and the config file parses as JSON with a
// schemaVersion field. Richer validation is left to port-pool itself.
import type { WorktreePort } from "@shigomori/contracts/schemas";
import { homedir } from "node:os";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { envSetting } from "@shared/config";
import {
  mergeWorktreePorts,
  type PoolPort,
} from "@shared/ports/mergeWorktreePorts";
import { parseWorktreeKey, worktreeKey } from "./config/project";
import type * as Engine from "./engine";
import * as Ops from "./engineOps";
import { isLoopbackPortListening } from "./net";
import { findProject, findWorktreePath } from "./projects";
import { answersFor } from "./util/cacheTtl";
import * as Processes from "./util/processes";

interface Worktree {
  readonly projectId: string;
  readonly worktreeId: string;
}

export class Ports extends Context.Service<
  Ports,
  {
    readonly list: (worktree: Worktree) => Effect.Effect<WorktreePort[]>;
    readonly portPoolInstalled: Effect.Effect<boolean>;
    // The toggle, the binary and the worktree's config: the one
    // decision both the preflight and the list read, so the toggle
    // governs every integration point. A stale worktree id reads false
    // with the toggle off.
    readonly portPoolActive: (worktree: Worktree) => Effect.Effect<boolean>;
    // port-pool's allocation for a directory, in the project's declared
    // order. Empty when it has none or port-pool has never run.
    readonly poolPorts: (dir: string) => Effect.Effect<PoolPort[]>;
  }
>()("sm/host/Ports") {}

const INSTALLED_TTL = Duration.seconds(30);
// A worktree's port list polls every few seconds while shown (its page,
// the Ports dialog, a Live card). A TTL past that interval means the
// state file is read once per window across every open list, and a
// fresh provision still shows within it. The config is cached per
// directory the same way: it changes about as often as the project.
const STATE_TTL = Duration.seconds(10);
// Resolving an id to its path forks `git worktree list`, and the list
// polls. A worktree's path is fixed for its id (the id IS a hash of the
// path, relocation mints a new one), so it is safe to hold: a deleted
// worktree's page is gone before the entry matters.
const PATH_TTL = Duration.minutes(1);

// A loopback dial answers in microseconds when something listens and
// is refused just as fast when nothing does. The deadline only matters
// for a wedged listener, and a short one keeps the list snappy.
const PROBE_TIMEOUT_MS = 400;

// Only the fields the list needs, read loosely: port-pool owns this
// file and may grow it. `portOrder` is the declared order from the
// project's config, which is the order the user thinks in. `ports`
// alone is unordered.
const AllocationSchema = Schema.Struct({
  dir: Schema.String,
  ports: Schema.Record(
    Schema.String,
    Schema.Int.check(Schema.isGreaterThan(0)),
  ),
  portOrder: Schema.optional(Schema.Array(Schema.String)),
});
const decodeAllocation = Schema.decodeUnknownOption(AllocationSchema);

const decodePortPoolState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      allocations: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
);

// Trailing separators aside, port-pool records the directory exactly as
// it was passed, and shigomori passes the worktree path git reports, so
// a plain string match is the honest comparison.
function normalizeDir(dir: string): string {
  return dir.length > 1 ? dir.replace(/[\\/]+$/, "") : dir;
}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The engine the reads below go through. A failed one is a defect:
  // the list has no failure of its own.
  const engine = yield* Effect.context<Engine.Services>();
  const read = <A, E>(effect: Effect.Effect<A, E, Engine.Services>) =>
    effect.pipe(Effect.provide(engine), Effect.orDie);

  const installed = yield* Processes.resolveOnPath("port-pool").pipe(
    Effect.map((resolved) => resolved !== null),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.cachedWithTTL(INSTALLED_TTL),
  );

  const configured = yield* Cache.make({
    lookup: (cwd: string) =>
      fs.readFileString(path.join(cwd, "port-pool.config.json")).pipe(
        Effect.flatMap((raw) =>
          Effect.try(() => "schemaVersion" in (JSON.parse(raw) as object)),
        ),
        Effect.orElseSucceed(() => false),
      ),
    capacity: Infinity,
    timeToLive: STATE_TTL,
  });

  // Keyed by the state file's path, so a change of XDG_DATA_HOME (the
  // proof's isolation, port-pool's own dev-run advice) is a different
  // entry rather than a stale hit. Read as plain JSON: the file and its
  // schemaVersion are port-pool's. Absent means port-pool has never run,
  // and corrupt is port-pool's to report: both read as no allocations.
  const allocations = yield* Cache.make({
    lookup: (statePath: string) =>
      fs.readFileString(statePath).pipe(
        Effect.flatMap(decodePortPoolState),
        Effect.map((state) => {
          const byDir = new Map<string, PoolPort[]>();
          for (const entry of state.allocations ?? []) {
            const parsed = decodeAllocation(entry);
            if (Option.isNone(parsed)) continue;
            const { dir, ports, portOrder } = parsed.value;
            const names = [
              ...(portOrder ?? []).filter((name) => name in ports),
              ...Object.keys(ports).filter(
                (name) => !portOrder?.includes(name),
              ),
            ];
            byDir.set(
              normalizeDir(dir),
              names.map((name) => ({ name, port: ports[name] as number })),
            );
          }
          return byDir;
        }),
        Effect.orElseSucceed(() => new Map<string, PoolPort[]>()),
      ),
    capacity: Infinity,
    timeToLive: STATE_TTL,
  });

  const paths = yield* Cache.makeWith(
    (key: string) => read(findWorktreePath(parseWorktreeKey(key))),
    {
      capacity: Infinity,
      timeToLive: answersFor(PATH_TTL),
    },
  );
  const pathOf = (worktree: Worktree) =>
    Cache.get(paths, worktreeKey(worktree.projectId, worktree.worktreeId));

  const statePath = () =>
    path.join(
      envSetting("XDG_DATA_HOME")?.trim() ||
        path.join(homedir(), ".local", "share"),
      "port-pool",
      "state.json",
    );

  const portPoolEnabled = read(Ops.readGlobalConfig()).pipe(
    Effect.map((config) => config.portPool === true),
  );

  // The toggle first, before anything forks git: off is the default.
  const active = Effect.fn("Ports.active")(function* (worktree: Worktree) {
    if (!(yield* portPoolEnabled)) return null;
    const dir = yield* pathOf(worktree);
    const [isInstalled, isConfigured] = yield* Effect.all(
      [installed, Cache.get(configured, dir)],
      { concurrency: 2 },
    );
    return isInstalled && isConfigured ? dir : null;
  });

  const poolPorts = Effect.fn("Ports.poolPorts")(function* (dir: string) {
    const byDir = yield* Cache.get(allocations, statePath());
    return byDir.get(normalizeDir(dir)) ?? [];
  });

  return Ports.of({
    list: Effect.fn("Ports.list")(function* (worktree) {
      // Validated first so a bogus project id never builds a path.
      yield* read(findProject(worktree.projectId));
      const [pool, data] = yield* Effect.all(
        [
          Effect.flatMap(active(worktree), (dir) =>
            dir === null ? Effect.succeed([]) : poolPorts(dir),
          ),
          read(Ops.readWorktreeData(worktree.projectId, worktree.worktreeId)),
        ],
        { concurrency: 2 },
      );
      return yield* Effect.forEach(
        mergeWorktreePorts(pool, data?.ports ?? []),
        (entry) =>
          Effect.promise(() =>
            isLoopbackPortListening(entry.port, PROBE_TIMEOUT_MS),
          ).pipe(Effect.map((listening) => ({ ...entry, listening }))),
        { concurrency: "unbounded" },
      );
    }),
    portPoolInstalled: installed.pipe(
      Effect.withSpan("Ports.portPoolInstalled"),
    ),
    portPoolActive: Effect.fn("Ports.portPoolActive")(function* (worktree) {
      return (yield* active(worktree)) !== null;
    }),
    poolPorts,
  });
});

export const layer = Layer.effect(Ports, make);
