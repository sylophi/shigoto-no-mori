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

// The pointer file as it was read: the file, the target it names, and
// why that target was refused (empty when it wasn't).
export type PointerFile = {
  readonly file: string;
  readonly target: string;
  readonly problem: string;
};

// Whether a directory has been used as a data dir: "present" when one
// of the state files is there, "absent" when none is (or the directory
// is missing), "unreadable" when it can't be told.
export type StateProbe = "present" | "absent" | "unreadable";

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
    readonly flavor: Flavor;
    // A `~` or `~/` path under the home directory, cleaned.
    readonly expandHome: (target: string) => string;
    readonly dataDir: string;
    readonly dataDirSource: DataDirSource;
    // The flavor's name for the data dir (.sm, .smd), which a managed
    // root on a project's own drive is named after.
    readonly dataDirName: string;
    // The terminal command's name (sm, smd), which messages that point
    // at a command spell.
    readonly binaryName: string;
    // The store's database file, in the data dir.
    readonly store: string;
    // XDG_CONFIG_HOME, else ~/.config.
    readonly configHome: string;
    // The pointer file read while finding the data dir, none when there
    // was none or SHIGOMORI_DATA_DIR made it moot.
    readonly pointer: Option.Option<PointerFile>;
    readonly holdsState: (dir: string) => Effect.Effect<StateProbe>;
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
  // Unset reads as the working directory, as it did for the Go sm.
  const home = yield* Config.String("HOME").pipe(Config.withDefault("."));
  // A `~/` path, joined to the home directory and cleaned as Go's
  // filepath.Join cleans it. Any other path as it is.
  const expandHome = (target: string) => {
    if (target === "~") return home;
    if (!target.startsWith("~/")) return target;
    const joined = path.join(home, target.slice(2));
    return joined.length > 1 ? joined.replace(/\/+$/, "") : joined;
  };

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

  const configHome = Option.getOrElse(yield* env("XDG_CONFIG_HOME"), () =>
    path.join(home, ".config"),
  );

  // The pointer file, and why its target is refused when it is. The
  // pre-2.0 file name is read only when the current one is absent.
  const readPointer = Effect.gen(function* () {
    for (const name of [names.pointer, names.legacyPointer]) {
      const file = path.join(configHome, names.configDir, name);
      const raw = yield* fs.readFileString(file).pipe(Effect.option);
      if (Option.isNone(raw)) continue;
      const target = expandHome(raw.value.trim());
      const problem =
        target === ""
          ? "it is empty"
          : !path.isAbsolute(target)
            ? "it isn't an absolute path"
            : !(yield* looksLikeDataDir(target))
              ? "it holds files that aren't sm's"
              : "";
      return Option.some<PointerFile>({ file, target, problem });
    }
    return Option.none<PointerFile>();
  });

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
        pointer: Option.none<PointerFile>(),
      };
    }
    if (Option.isSome(yield* env("SHIGOMORI_ROOT"))) {
      return yield* new RetiredRootVariable();
    }
    const pointer = yield* readPointer;
    if (Option.isSome(pointer) && pointer.value.problem === "") {
      return {
        dataDir: pointer.value.target,
        source: "pointer" as const,
        pointer,
      };
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
      return { dataDir: legacy, source: "legacy" as const, pointer };
    }
    return { dataDir: current, source: "default" as const, pointer };
  });

  return Paths.of({
    home,
    flavor,
    expandHome,
    dataDir: resolved.dataDir,
    dataDirSource: resolved.source,
    dataDirName: names.dataDir,
    binaryName: names.binaryName,
    store: path.join(resolved.dataDir, "store.db"),
    configHome,
    pointer: resolved.pointer,
    holdsState,
  });
});

export const layer = (flavor: Flavor) => Layer.effect(Paths, make(flavor));
