// A worktree's ports (packages/contracts/src/modules/ports.ts): the ones
// port-pool wrote into the worktree's env files, then the user-added
// entries from its data, each probed on this machine's loopback. Which
// ports port-pool wrote is the engine's reading (Worktrees.poolPorts),
// the one `sm worktrees status` prints; whether sm provisions and
// releases them there is Worktrees.portPoolActive.
import { findExecutable } from "@shigomori/engine/executables";
import * as EngineConfig from "@shigomori/engine/Config";
import * as Worktrees from "@shigomori/engine/Worktrees";
import { type WorktreePort } from "@shigomori/contracts/schemas";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { mergeWorktreePorts } from "@shared/ports/mergeWorktreePorts";
import { parseWorktreeKey, worktreeKey } from "./config/project";
import type * as Engine from "./Engine";
import * as Ops from "./engineOps";
import { isLoopbackPortListening } from "./net";
import { findProject, findWorktreeIdentity } from "./projects";
import { keptAnswer, keptAnswers } from "./util/kept";

interface Worktree {
  readonly projectId: string;
  readonly worktreeId: string;
}

export class Ports extends Context.Service<
  Ports,
  {
    readonly list: (worktree: Worktree) => Effect.Effect<WorktreePort[]>;
    readonly portPoolInstalled: Effect.Effect<boolean>;
    // Whether sm provisions and releases port-pool's ports in the
    // worktree: the preflight and the Scripts section's rows. A stale
    // worktree id reads false.
    readonly portPoolActive: (worktree: Worktree) => Effect.Effect<boolean>;
  }
>()("sm/host/Ports") {}

const INSTALLED_TTL = Duration.seconds(30);
// Resolving an id to its checkout reads the project's worktree list,
// and the list polls. A worktree's path is fixed for its id (the id IS
// a hash of the path, relocation mints a new one), so it is safe to
// hold: a deleted worktree's page is gone before the entry matters.
const IDENTITY_TTL = Duration.minutes(1);
// A worktree's port list polls every few seconds while shown (its page,
// the Ports dialog, a Live card): its config and env files are read once
// per window across every open list, and a fresh provision still shows
// within it.
const POOL_TTL = Duration.seconds(10);

// A loopback dial answers in microseconds when something listens and
// is refused just as fast when nothing does. The deadline only matters
// for a wedged listener, and a short one keeps the list snappy.
const PROBE_TIMEOUT_MS = 400;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The engine the reads below go through. A failed one is a defect:
  // the list has no failure of its own.
  const engine = yield* Effect.context<Engine.Services>();
  const read = <A, E>(effect: Effect.Effect<A, E, Engine.Services>) =>
    effect.pipe(Effect.provide(engine), Effect.orDie);

  const installed = yield* keptAnswer(
    findExecutable("port-pool").pipe(
      Effect.map(Option.isSome),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    ),
    INSTALLED_TTL,
  );

  const identities = yield* keptAnswers((key: string) => {
    const { projectId, worktreeId } = parseWorktreeKey(key);
    return findWorktreeIdentity(projectId, worktreeId).pipe(
      Effect.provide(engine),
    );
  }, IDENTITY_TTL);
  const identityOf = (worktree: Worktree) =>
    identities.get(worktreeKey(worktree.projectId, worktree.worktreeId)).pipe(
      Effect.asSome,
      Effect.catchTag("UnknownWorktreeError", () => Effect.succeedNone),
      Effect.orDie,
    );

  // In the project's declared order, the order the user thinks in.
  const poolPorts = yield* keptAnswers(
    (dir: string) =>
      read(
        Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
          worktrees.poolPorts(dir),
        ),
      ).pipe(
        Effect.map(({ config, ports }) =>
          config.portNames.flatMap((name) =>
            ports
              .filter((port) => port.name === name)
              .map(({ port }) => ({ name, port })),
          ),
        ),
      ),
    POOL_TTL,
  );

  // The toggle first, before anything forks git: off is the default.
  const active = Effect.fn("Ports.portPoolActive")(function* (
    worktree: Worktree,
  ) {
    const enabled = yield* read(
      Effect.flatMap(EngineConfig.Config, (config) =>
        config.device("portPool"),
      ),
    );
    if (!enabled) return false;
    const found = yield* identityOf(worktree);
    if (Option.isNone(found)) return false;
    return yield* read(
      Effect.flatMap(Worktrees.Worktrees, (worktrees) =>
        worktrees.portPoolActive(found.value, installed),
      ),
    );
  });

  return Ports.of({
    list: Effect.fn("Ports.list")(function* (worktree) {
      // Validated first so a bogus project id never builds a path.
      yield* read(findProject(worktree.projectId));
      const [pool, data] = yield* Effect.all(
        [
          Effect.flatMap(identityOf(worktree), (found) =>
            Option.isNone(found)
              ? Effect.succeed([])
              : poolPorts.get(found.value.path),
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
    portPoolActive: active,
  });
});

export const layer = Layer.effect(Ports, make);
