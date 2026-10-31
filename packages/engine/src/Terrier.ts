import type { TerrierReadiness } from "@shigomori/contracts/schemas/terrier";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "./Config.ts";
import * as Paths from "./Paths.ts";
import { isNotFound } from "./platformErrors.ts";
import { byPlatform } from "./platform.ts";
import { captureWithin, exec, stderrOf } from "./processes.ts";
import { terrierProjectId } from "./terrierId.ts";

// Terrier (github.com/dittofleet/terrier) is an external registry of
// repo paths, listed as projects beside the registry's own while the
// device's `terrier` setting is on. `terrier ls --json` is all this
// reads, and `terrier add` and `terrier rm` by path all it writes, so
// terrier's version doesn't matter, only whether that output still has
// the shape read here.

// Why the setting is on and no terrier projects are listed: the words
// a warning and doctor use.
type TerrierTrouble = {
  readonly summary: string;
  readonly advice: string;
};

export type TerrierListing = {
  // Absolute paths, in terrier's order.
  readonly paths: ReadonlyArray<string>;
  // None while the setting is off, or when the registry was read.
  readonly trouble: Option.Option<TerrierTrouble>;
};

// The project a terrier repo lists as, under an id minted from its
// path, so every process agrees on it without storing it.
export type TerrierProject = {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly source: "terrier";
};

// terrier refused an add or a rm, in its words.
export class TerrierRefused extends Schema.TaggedError<TerrierRefused>()(
  "TerrierRefused",
  {
    verb: Schema.Literals(["add", "rm"]),
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `terrier ${this.verb} failed: ${this.reason}`;
  }
}

export class Terrier extends Context.Service<
  Terrier,
  {
    readonly listing: Effect.Effect<TerrierListing>;
    // Whether terrier is installed, and whether `terrier ls --json`
    // answers in the shape read here: the Settings toggle's readiness.
    readonly readiness: Effect.Effect<TerrierReadiness>;
    // Registers a repo in terrier. Already registered is a success there.
    readonly add: (path: string) => Effect.Effect<void, TerrierRefused>;
    // Unregisters the repo terrier lists at `path`.
    readonly remove: (path: string) => Effect.Effect<void, TerrierRefused>;
    // The next ask reads terrier again, for a toggle just flipped.
    readonly invalidate: Effect.Effect<void>;
  }
>()("sm/engine/Terrier") {}

// Why `terrier ls --json` couldn't be read.
class TerrierUnreadable extends Schema.TaggedError<TerrierUnreadable>()(
  "TerrierUnreadable",
  { reason: Schema.String },
) {}

// A missing `projects` or a row without `path` is an error rather than
// an empty list, so a terrier whose output changed shape says so
// instead of quietly listing nothing. Rows' other fields are terrier's.
const parseListing = (
  stdout: string,
): Effect.Effect<ReadonlyArray<string>, TerrierUnreadable> => {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch (error) {
    // Go's encoding/json words for the commonest case, output that isn't
    // JSON at all.
    const first = stdout.trimStart()[0];
    return Effect.fail(
      new TerrierUnreadable({
        reason:
          first !== undefined && !/[[{"\-\d tfn]/.test(first)
            ? `invalid character '${first}' looking for beginning of value`
            : String(error),
      }),
    );
  }
  if (!Predicate.isObject(doc) || Array.isArray(doc)) {
    return Effect.fail(
      new TerrierUnreadable({ reason: "its output isn't a JSON object" }),
    );
  }
  const projects = (doc as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) {
    return Effect.fail(
      new TerrierUnreadable({ reason: "no projects list in its output" }),
    );
  }
  const paths: string[] = [];
  for (const row of projects as ReadonlyArray<unknown>) {
    const path = Predicate.isObject(row)
      ? (row as { path?: unknown }).path
      : undefined;
    if (typeof path !== "string") {
      return Effect.fail(
        new TerrierUnreadable({
          reason: "a project without a path in its output",
        }),
      );
    }
    paths.push(path);
  }
  return Effect.succeed(paths);
};

// The last element of a path, as Go's filepath.Base takes it.
const baseName = (path: string) => {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1);
};

// terrier answered with a failure.
class TerrierCommandFailed extends Schema.TaggedError<TerrierCommandFailed>()(
  "TerrierCommandFailed",
  { args: Schema.Array(Schema.String), code: Schema.Int },
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
  // wedge: the listing runs before every command.
  const output = (args: ReadonlyArray<string>) =>
    captureWithin(spawner, "terrier", args, "10 seconds").pipe(
      Effect.flatMap((ran) =>
        ran.code === 0
          ? Effect.succeed(ran.output)
          : Effect.fail(
              new TerrierCommandFailed({ args: [...args], code: ran.code }),
            ),
      ),
    );

  // What `terrier ls --json` answered, toggle or not.
  const probe = output(["ls", "--json"]).pipe(
    Effect.flatMap(parseListing),
    Effect.map((paths) => ({ kind: "listed" as const, paths })),
    Effect.catchIf(
      (error) =>
        Predicate.isTagged(error, "PlatformError") && isNotFound(error),
      () => Effect.succeed({ kind: "missing" as const }),
    ),
    Effect.catchTags({
      TerrierCommandFailed: ({ code }) =>
        Effect.succeed({
          kind: "unreadable" as const,
          reason: `exit status ${code}`,
        }),
      TerrierUnreadable: ({ reason }) =>
        Effect.succeed({ kind: "unreadable" as const, reason }),
      CommandTimedOut: () =>
        Effect.succeed({
          kind: "unreadable" as const,
          reason: "signal: killed",
        }),
      PlatformError: (error) =>
        Effect.succeed({
          kind: "unreadable" as const,
          reason: error.message,
        }),
    }),
  );

  const listingOf = (listed: Effect.Success<typeof probe>): TerrierListing => {
    if (listed.kind === "missing") {
      return trouble(
        "on in Settings but `terrier` isn't on PATH, so no terrier projects are listed",
        byPlatform({
          darwin:
            "Install terrier, or turn the toggle off in the app's Settings.",
          linux: `Install terrier, or turn it off (\`${binaryName} config set terrier false\`).`,
        }),
      );
    }
    if (listed.kind === "unreadable") {
      return trouble(
        `\`terrier ls --json\` failed (${listed.reason}), so no terrier projects are listed`,
        `Run \`terrier ls --json\` by hand to see what it says, and update ${binaryName} if its output changed.`,
      );
    }
    // Home-expanded and absolute, never resolved against the working
    // directory, which differs between the app and a shell.
    const paths = listed.paths.flatMap((path) => {
      const expanded = expandHome(path);
      return expanded.startsWith("/") ? [expanded] : [];
    });
    return { paths, trouble: Option.none() };
  };

  // terrier's answer is kept briefly, so a listing's several asks share
  // one spawn and a long-lived host still sees terrier change. The switch
  // is read on every ask, so a view re-read as it flips lists the
  // projects it brings or takes.
  // One entry, keyed by nothing: a Cache rather than a cached effect
  // because invalidating it also drops a probe under way, which may have
  // started before terrier was installed or its toggle flipped.
  const cache = yield* Cache.make({
    lookup: (_: void) => probe,
    capacity: 1,
    timeToLive: "10 seconds",
  });
  const answered = Cache.get(cache, undefined);
  const invalidate = Cache.invalidateAll(cache);

  // A write is read back by the next ask, so a project added or removed
  // right after lists as terrier now does.
  const write = (verb: "add" | "rm", path: string) =>
    exec("terrier", [verb, "--", path], { timeout: "10 seconds" }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.catchTags({
        CommandError: (cause) =>
          Effect.fail(
            new TerrierRefused({
              verb,
              reason: stderrOf(cause).replace(/^Error: /, "") || cause.message,
              cause,
            }),
          ),
      }),
      Effect.ensuring(invalidate),
    );
  return Terrier.of({
    listing: Effect.gen(function* () {
      if (!(yield* config.device("terrier"))) {
        return { paths: [], trouble: Option.none() };
      }
      return listingOf(yield* answered);
    }).pipe(Effect.orDie, Effect.withSpan("Terrier.listing")),
    readiness: Effect.map(answered, (listed) => ({
      installed: listed.kind !== "missing",
      readable: listed.kind === "listed",
    })).pipe(Effect.orDie, Effect.withSpan("Terrier.readiness")),
    add: Effect.fn("Terrier.add")(function* (path: string) {
      yield* write("add", path);
    }),
    remove: Effect.fn("Terrier.remove")(function* (path: string) {
      yield* write("rm", path);
    }),
    invalidate,
  });
});

export const layer = Layer.effect(Terrier, make);
