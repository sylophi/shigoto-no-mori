import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "./Config.ts";
import * as Paths from "./Paths.ts";
import { isNotFound } from "./platformErrors.ts";
import { terrierProjectId } from "./terrierId.ts";

// Terrier (github.com/dittofleet/terrier) is an external registry of
// repo paths, listed as projects beside the registry's own while the
// device's `terrier` setting is on. Its stable surface is `terrier ls
// --json`, and a minor version bump is its compatibility signal.

// Why the setting is on and no terrier projects are listed: the words
// a warning and doctor use.
export type TerrierTrouble = {
  readonly summary: string;
  readonly advice: string;
};

export type TerrierListing = {
  // Absolute paths, in terrier's order.
  readonly paths: ReadonlyArray<string>;
  // None while the setting is off, or when the registry was read.
  readonly trouble: Option.Option<TerrierTrouble>;
};

// The project a terrier repo lists as: read-only, under an id minted
// from its path, so every process agrees on it without storing it.
export type TerrierProject = {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly source: "terrier";
};

export class Terrier extends Context.Service<
  Terrier,
  {
    readonly listing: Effect.Effect<TerrierListing>;
  }
>()("sm/engine/Terrier") {}

// The read contract this build understands: v0.1.x.
const SUPPORTED_MAJOR = 0;
const SUPPORTED_MINOR = 1;

const LsSchema = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ path: Schema.String })),
});

// The last element of a path, as Go's filepath.Base takes it.
const baseName = (path: string) => {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

// terrier answered with a failure.
class TerrierCommandFailed extends Schema.TaggedError<TerrierCommandFailed>()(
  "TerrierCommandFailed",
  { args: Schema.Array(Schema.String), code: Schema.Number },
) {}

// Code-unit order, as Go compares strings.
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const trouble = (summary: string, advice: string): TerrierListing => ({
  paths: [],
  trouble: Option.some({ summary, advice }),
});

// The projects terrier adds to `registered`: one per path the registry
// doesn't hold, by name then path. The manual order goes over the
// merged list afterwards.
export function terrierProjects(
  registeredPaths: ReadonlySet<string>,
  paths: ReadonlyArray<string>,
): ReadonlyArray<TerrierProject> {
  const known = new Set(registeredPaths);
  const extras: TerrierProject[] = [];
  for (const path of paths) {
    if (path === "" || known.has(path)) continue;
    known.add(path);
    extras.push({
      id: terrierProjectId(path),
      name: baseName(path),
      path,
      source: "terrier",
    });
  }
  return extras.toSorted(
    (a, b) => compare(a.name, b.name) || compare(a.path, b.path),
  );
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* Config.Config;
  const { expandHome, binaryName } = yield* Paths.Paths;

  // terrier's stdout, failing on a spawn error, a nonzero exit or a
  // wedge: the listing runs before every command. stderr is drained so
  // a chatty terrier can't stall on a full pipe.
  const output = (args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("terrier", [...args], { stdin: "ignore" }),
        );
        const [stdout, , code] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            Stream.runDrain(handle.stderr),
            handle.exitCode,
          ],
          { concurrency: 3 },
        );
        if (code !== 0) {
          return yield* new TerrierCommandFailed({ args: [...args], code });
        }
        return stdout;
      }),
    ).pipe(Effect.timeout("10 seconds"));

  // The binary's version, once per process: none when terrier isn't on
  // PATH, empty when it answers with nothing usable.
  const version = yield* Effect.cached(
    output(["version"]).pipe(
      Effect.map((stdout) => Option.some(stdout.trim())),
      Effect.catchIf(
        (error) =>
          Predicate.isTagged(error, "PlatformError") && isNotFound(error),
        () => Effect.succeed(Option.none<string>()),
      ),
      Effect.orElseSucceed(() => Option.some("")),
    ),
  );

  const read = Effect.gen(function* () {
    const enabled = yield* config.get({ kind: "device" }, "terrier");
    if (enabled.value !== true) {
      return { paths: [], trouble: Option.none() };
    }
    const found = yield* version;
    if (Option.isNone(found)) {
      return trouble(
        "enabled in config.json but `terrier` isn't on PATH, so no terrier projects are listed",
        "Install terrier, or turn the toggle off in the app's Settings.",
      );
    }
    const [, major, minor] = /^v(\d+)\.(\d+)/.exec(found.value) ?? [];
    if (
      Number(major) !== SUPPORTED_MAJOR ||
      Number(minor) !== SUPPORTED_MINOR
    ) {
      return trouble(
        `${found.value || "(version unreadable)"} isn't a version this build understands (wants v${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}), so no terrier projects are listed`,
        `Update ${binaryName} and terrier to versions that agree.`,
      );
    }
    const listed = yield* output(["ls", "--json"]).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(LsSchema)),
      ),
      Effect.option,
    );
    if (Option.isNone(listed)) {
      return trouble(
        "`terrier ls --json` failed",
        "Run `terrier ls` by hand to see what it says.",
      );
    }
    // Home-expanded and absolute, never resolved against the working
    // directory, which differs between the app and a shell.
    const paths = listed.value.projects.flatMap(({ path }) => {
      const expanded = expandHome(path);
      return expanded.startsWith("/") ? [expanded] : [];
    });
    return { paths, trouble: Option.none() };
  }).pipe(Effect.orDie, Effect.withSpan("Terrier.listing"));

  // Kept briefly, so a listing's several asks share one answer and a
  // long-lived host still sees the setting or terrier change.
  return Terrier.of({
    listing: yield* Effect.cachedWithTTL(read, "10 seconds"),
  });
});

export const layer = Layer.effect(Terrier, make);
