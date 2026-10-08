import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { type Flavor, flavorNames } from "./flavor.ts";
import { isAbsent, isNotFound } from "./platformErrors.ts";

// How the data dir was found: the SHIGOMORI_DATA_DIR override, the
// pointer file, a pre-2.0 default adopted in place, or the flavor's
// default under the home directory.
export type DataDirSource = "env" | "pointer" | "legacy" | "default";

export class RetiredRootVariable extends Schema.TaggedError<RetiredRootVariable>()(
  "RetiredRootVariable",
  {},
) {
  override get message(): string {
    return "SHIGOMORI_ROOT is no longer read. Set SHIGOMORI_DATA_DIR instead.";
  }
}

// The files whose presence marks a directory as a used data dir: the
// store, and the JSON files it imports.
const STATE_FILES = [
  "store.db",
  "registry.json",
  "state.json",
  "config.json",
] as const;

export class Paths extends Context.Service<
  Paths,
  {
    // The user's home directory.
    readonly home: string;
    readonly dataDir: string;
    readonly dataDirSource: DataDirSource;
    // The store's database file, in the data dir.
    readonly store: string;
  }
>()("sm/engine/Paths") {}

// An environment variable, none when unset or empty.
const env = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => value !== "")),
  );

const make = Effect.fn("Paths.make")(function* (flavor: Flavor) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = flavorNames(flavor);
  // Unset reads as the working directory, as it does for the Go sm.
  const home = yield* Config.String("HOME").pipe(Config.withDefault("."));
  const expandHome = (target: string) =>
    target === "~"
      ? home
      : target.startsWith("~/")
        ? path.join(home, target.slice(2))
        : target;

  // A directory a pointer may aim at: one that doesn't exist yet, is
  // empty, or already holds sm's state, so a pointer at ~/Documents
  // falls back to the default instead of adopting unrelated files.
  const looksLikeDataDir = (target: string) =>
    fs.readDirectory(target).pipe(
      Effect.map(
        (entries) =>
          entries.length === 0 ||
          entries.some((entry) => STATE_FILES.some((file) => file === entry)),
      ),
      Effect.catchIf(isNotFound, () => Effect.succeed(true)),
      Effect.orElseSucceed(() => false),
    );

  // The pointer file's target when it names a usable data dir. The
  // pre-2.0 file name is read only when the current one is absent.
  const pointed = Effect.gen(function* () {
    const configHome = Option.getOrElse(yield* env("XDG_CONFIG_HOME"), () =>
      path.join(home, ".config"),
    );
    for (const name of [names.pointer, names.legacyPointer]) {
      const raw = yield* fs
        .readFileString(path.join(configHome, names.configDir, name))
        .pipe(Effect.option);
      if (Option.isNone(raw)) continue;
      const target = expandHome(raw.value.trim());
      return target !== "" &&
        path.isAbsolute(target) &&
        (yield* looksLikeDataDir(target))
        ? Option.some(target)
        : Option.none<string>();
    }
    return Option.none<string>();
  });

  // Whether a directory has been used as a data dir: "present" when
  // one of the state files is there, "absent" when none is (or the
  // directory is missing), "unreadable" when it can't be told.
  const holdsState = Effect.fn(function* (dir: string) {
    let unreadable = false;
    for (const file of STATE_FILES) {
      const exists = yield* fs.exists(path.join(dir, file)).pipe(
        // A data dir path that is a file holds nothing.
        Effect.catchIf(isAbsent, () => Effect.succeed(false)),
        Effect.orElseSucceed(() => {
          unreadable = true;
          return false;
        }),
      );
      if (exists) return "present" as const;
    }
    return unreadable ? ("unreadable" as const) : ("absent" as const);
  });

  const resolved = yield* Effect.gen(function* () {
    const override = yield* env("SHIGOMORI_DATA_DIR");
    if (Option.isSome(override)) {
      return {
        dataDir: path.resolve(expandHome(override.value)),
        source: "env" as const,
      };
    }
    if (Option.isSome(yield* env("SHIGOMORI_ROOT"))) {
      return yield* new RetiredRootVariable();
    }
    const target = yield* pointed;
    if (Option.isSome(target)) {
      return { dataDir: target.value, source: "pointer" as const };
    }
    const current = path.join(home, names.dataDir);
    const legacy = path.join(home, names.legacyDataDir);
    // A pre-2.0 dir that still holds state is used where it stands while
    // the current name holds none, so an upgrade never runs against an
    // empty data dir beside a full one.
    if (
      (yield* holdsState(current)) !== "present" &&
      (yield* holdsState(legacy)) !== "absent"
    ) {
      return { dataDir: legacy, source: "legacy" as const };
    }
    return { dataDir: current, source: "default" as const };
  });

  return Paths.of({
    home,
    dataDir: resolved.dataDir,
    dataDirSource: resolved.source,
    store: path.join(resolved.dataDir, "store.db"),
  });
});

export const layer = (flavor: Flavor) => Layer.effect(Paths, make(flavor));
