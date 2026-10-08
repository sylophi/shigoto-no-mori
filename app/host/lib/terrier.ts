// Terrier integration (github.com/dittofleet/terrier): an external
// registry of repo paths, merged into the project list when the global
// `terrier` toggle is on. The merge is the CLI's (cli/terrier.go, read
// through `sm projects list`); what the app keeps is the readiness
// probe behind the Settings toggle: is terrier installed, and does its
// version speak the registry-read contract this build understands.
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { TerrierReadiness } from "@shigomori/contracts/schemas";
import * as Processes from "./util/processes";
import * as PromiseAdapter from "./util/promiseAdapter";

export class Terrier extends Context.Service<
  Terrier,
  {
    readonly readiness: Effect.Effect<TerrierReadiness>;
    // For the global-config write flipping the toggle: the next read
    // re-asks instead of serving up to a TTL of the pre-write world.
    readonly invalidate: Effect.Effect<void>;
  }
>()("sm/host/Terrier") {}

// A wedged terrier must not hang the Settings panel waiting on it.
const TERRIER_SPAWN_TIMEOUT_MS = 10_000;

// The registry-read contract the bundled CLI understands
// (terrierSupported* in cli/terrier.go, which decides whether the merge
// runs). Terrier's README says a tool checks the minor version and
// nothing else, so the toggle reports an unknown minor as incompatible
// rather than guessing.
const TERRIER_SUPPORTED_MAJOR = 0;
const TERRIER_SUPPORTED_MINOR = 1;

const READINESS_TTL = Duration.seconds(30);

// One spawn answers both questions: a missing binary is "not
// installed", any output is the version to run the minor handshake
// against.
const readiness = Processes.exec("terrier", ["version"], {
  timeout: TERRIER_SPAWN_TIMEOUT_MS,
}).pipe(
  Effect.map(({ stdout }): TerrierReadiness => {
    const version = stdout.trim();
    return {
      installed: true,
      compatible: versionCompatible(version),
      version: version || undefined,
    };
  }),
  Effect.catchTags({
    CommandError: (error) =>
      Effect.succeed({
        installed: error.reason !== "not-found",
        compatible: false,
      }),
  }),
);

function versionCompatible(version: string): boolean {
  const match = /^v(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  return (
    Number(match[1]) === TERRIER_SUPPORTED_MAJOR &&
    Number(match[2]) === TERRIER_SUPPORTED_MINOR
  );
}

// One entry, keyed by nothing: a Cache rather than a cached effect
// because invalidating it also drops a probe under way, which may have
// started before terrier was installed.
const make = Effect.gen(function* () {
  const cache = yield* Cache.make({
    lookup: (_: void) => readiness,
    capacity: 1,
    timeToLive: READINESS_TTL,
  });
  return Terrier.of({
    readiness: Cache.get(cache, undefined).pipe(
      Effect.withSpan("Terrier.readiness"),
    ),
    invalidate: Cache.invalidateAll(cache).pipe(
      Effect.withSpan("Terrier.invalidate"),
    ),
  });
});

export const layer = Layer.effect(Terrier, make);

// The Promise face, for the terrier and global-config handlers.
const promiseAdapter = PromiseAdapter.forService(Terrier, "terrier");
export const adapter = promiseAdapter.layer;

export const terrierReadiness = () =>
  promiseAdapter.call((terrier) => terrier.readiness);
// Settles at once when the graph is not up, with nothing cached.
export const invalidateTerrierReadiness = () =>
  promiseAdapter.runIfOpen(Effect.flatMap(Terrier, (t) => t.invalidate));
