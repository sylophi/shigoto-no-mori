import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expandHome as expandHomeIn } from "./expandHome.ts";
import { type Flavor, flavorNames } from "./flavor.ts";
import { rescueStrandedMove } from "./dataDirMoveJournal.ts";
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

class RetiredRootVariable extends Schema.TaggedError<RetiredRootVariable>()(
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
    // Where the pointer file goes, which redirects the data dir away from
    // the flavor's default: one line holding an absolute path, outside
    // the data dir (nothing inside it can say where it is). The pre-2.0
    // name is read only when that one is absent, and never written.
    readonly pointerFile: string;
    readonly legacyPointerFile: string | null;
    // The flavor's data dir under the home directory, which needs no
    // pointer.
    readonly defaultDataDir: string;
    // The pointer file read while finding the data dir, none when there
    // was none or SHIGOMORI_DATA_DIR made it moot.
    readonly pointer: Option.Option<PointerFile>;
    // Where the data dir is found now, which a move committed since this
    // process found it makes another place than `dataDir`.
    readonly current: Effect.Effect<string>;
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
  const expandHome = (target: string) => expandHomeIn(home, target);

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
  const pointerFile = path.join(configHome, names.configDir, names.pointer);
  const legacyPointerFile =
    names.legacyPointer === null
      ? null
      : path.join(configHome, names.configDir, names.legacyPointer);
  const defaultDataDir = path.join(home, names.dataDir);

  // The pointer file, and why its target is refused when it is. The
  // pre-2.0 file name is read only when the current one is absent.
  const readPointer = Effect.gen(function* () {
    for (const file of [pointerFile, legacyPointerFile]) {
      if (file === null) continue;
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

  const resolve = Effect.gen(function* () {
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
    const current = defaultDataDir;
    const legacy =
      names.legacyDataDir === null
        ? null
        : path.join(home, names.legacyDataDir);
    // A pre-2.0 dir that still holds state is used where it stands while
    // the current name holds none, so an upgrade never runs against an
    // empty data dir beside a full one.
    if (
      legacy !== null &&
      (yield* holdsState(current)) !== "present" &&
      (yield* holdsState(legacy)) !== "absent"
    ) {
      return { dataDir: legacy, source: "legacy" as const, pointer };
    }
    return { dataDir: current, source: "default" as const, pointer };
  });

  // The environment as this process found it, which a later read sees
  // too.
  const provider = yield* ConfigProvider.ConfigProvider;

  // Where the data dir is found, with a move a crash cut before its
  // pointer moved committed first, and the data dir found again where the
  // move left it, before any process can make a fresh store at the folder
  // that left.
  const locate = Effect.gen(function* () {
    const found = yield* resolve;
    if (
      found.source === "env" ||
      (yield* fs.exists(found.dataDir).pipe(Effect.orElseSucceed(() => true)))
    ) {
      return found;
    }
    yield* rescueStrandedMove({
      named: found.dataDir,
      pointerFile,
      legacyPointerFile,
      defaultDataDir,
    });
    // Found again either way: another process may have made the same
    // rescue first.
    return yield* resolve;
  });
  const resolved = yield* locate;

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
    pointerFile,
    legacyPointerFile,
    defaultDataDir,
    pointer: resolved.pointer,
    // Its one failure, a retired variable, would have stopped the start.
    // A rescue that can't commit leaves the folder that left, which is
    // gone.
    current: Effect.map(locate, ({ dataDir }) => dataDir).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.orElseSucceed(() => resolved.dataDir),
    ),
    holdsState,
  });
});

export const layer = (flavor: Flavor) => Layer.effect(Paths, make(flavor));
