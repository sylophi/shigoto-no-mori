// The app's side of terrier, the user's tool that keeps a cross-tool
// registry of repo paths, merged into the project list when the global
// `terrier` toggle is on. The merge is the engine's (Terrier.ts, read
// through Projects.list); what the app keeps is the readiness
// probe behind the Settings toggle: is terrier installed, and does
// `terrier ls --json` still answer in the shape the engine reads. And
// `terrier add`, for the add-project dialog's offer to register a new
// project there too.
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { TerrierReadiness } from "@shigomori/contracts/schemas";
import * as Processes from "./util/processes";

// terrier refused the add, in its words.
class TerrierAddError extends Schema.TaggedError<TerrierAddError>()(
  "TerrierAddError",
  { reason: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `terrier add failed: ${this.reason}`;
  }
}

export class Terrier extends Context.Service<
  Terrier,
  {
    readonly readiness: Effect.Effect<TerrierReadiness>;
    // Registers a repo in terrier. Already registered is a success there.
    readonly add: (path: string) => Effect.Effect<void, TerrierAddError>;
    // For the global-config write flipping the toggle: the next read
    // re-asks instead of serving up to a TTL of the pre-write world.
    readonly invalidate: Effect.Effect<void>;
  }
>()("sm/host/Terrier") {}

// A wedged terrier must not hang the Settings panel waiting on it.
const TERRIER_SPAWN_TIMEOUT_MS = 10_000;

const READINESS_TTL = Duration.seconds(30);

// What the engine reads out of `terrier ls --json`
// (Terrier.ts), so Settings calls the
// integration ready exactly when the merge would run.
const isTerrierListing = Schema.is(
  Schema.Struct({
    projects: Schema.Array(Schema.Struct({ path: Schema.String })),
  }),
);

const parsesAsListing = (stdout: string): boolean => {
  try {
    return isTerrierListing(JSON.parse(stdout));
  } catch {
    return false;
  }
};

// One spawn answers both questions: a missing binary is "not
// installed", and the output either parses as a listing or doesn't.
const readiness = Processes.exec("terrier", ["ls", "--json"], {
  timeout: TERRIER_SPAWN_TIMEOUT_MS,
}).pipe(
  Effect.map(
    ({ stdout }): TerrierReadiness => ({
      installed: true,
      readable: parsesAsListing(stdout),
    }),
  ),
  Effect.catchTags({
    CommandError: (error) =>
      Effect.succeed({
        installed: error.reason !== "not-found",
        readable: false,
      }),
  }),
);

// One entry, keyed by nothing: a Cache rather than a cached effect
// because invalidating it also drops a probe under way, which may have
// started before terrier was installed.
const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cache = yield* Cache.make({
    lookup: (_: void) => readiness,
    capacity: 1,
    timeToLive: READINESS_TTL,
  });
  return Terrier.of({
    readiness: Cache.get(cache, undefined).pipe(
      Effect.withSpan("Terrier.readiness"),
    ),
    add: Effect.fn("Terrier.add")(function* (path: string) {
      yield* Processes.exec("terrier", ["add", "--", path], {
        timeout: TERRIER_SPAWN_TIMEOUT_MS,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catchTags({
          CommandError: (cause) =>
            Effect.fail(
              new TerrierAddError({
                reason:
                  Processes.stderrOf(cause).replace(/^Error: /, "") ||
                  cause.message,
                cause,
              }),
            ),
        }),
      );
    }),
    invalidate: Cache.invalidateAll(cache).pipe(
      Effect.withSpan("Terrier.invalidate"),
    ),
  });
});

export const layer = Layer.effect(Terrier, make);
