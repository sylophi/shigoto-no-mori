// The filesystem calls Node has no binding for, through the bundled
// helper (nativefs/ at the repo root), whose own files answer for each
// OS, so nothing here knows which one it runs on. Each method asks once for
// a whole tree, or for a list of paths, and streams one entry per
// path in no particular order. A path the helper could not answer for
// is an entry with an `error`, not a failure of the stream: the stream
// fails only when the helper itself does.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export class NativeFsError extends Schema.TaggedError<NativeFsError>()(
  "NativeFsError",
  {
    method: Schema.Literals([
      "clone",
      "exchange",
      "flags",
      "xattrs",
      "cloneable",
      "lstat",
    ]),
    reason: Schema.Literals(["spawn", "exit", "output"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The filesystem helper failed (${this.method}, ${this.reason}).`;
  }
}

// What the helper could not do for one path: the errno's name
// ("ENOENT") and its text.
const EntryError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
});

const Failed = Schema.Struct({ path: Schema.String, error: EntryError });

const Cloned = Schema.Struct({ path: Schema.String });

const Flags = Schema.Struct({
  path: Schema.String,
  flags: Schema.Int,
});

const Xattrs = Schema.Struct({
  path: Schema.String,
  names: Schema.Array(Schema.String),
});

// lstat(2), times to the nanosecond: what git's index records of a file,
// the file flags a checkout's own files don't carry, and the blocks and
// links a disk usage count needs.
const Lstat = Schema.Struct({
  path: Schema.String,
  dev: Schema.Int,
  ino: Schema.Int,
  mode: Schema.Int,
  uid: Schema.Int,
  gid: Schema.Int,
  size: Schema.Int,
  ctimeSec: Schema.Int,
  ctimeNsec: Schema.Int,
  mtimeSec: Schema.Int,
  mtimeNsec: Schema.Int,
  flags: Schema.Int,
  blocks: Schema.Int,
  nlink: Schema.Int,
  privateBytes: Schema.optionalKey(Schema.Int),
});
export type LstatEntry = typeof Lstat.Type;

// A file's kind, from its mode.
export const S_IFMT = 0o170000;
export const S_IFDIR = 0o040000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;

const Cloneability = Schema.Struct({
  path: Schema.String,
  cloneable: Schema.Boolean,
});

export type Entry<A> = A | typeof Failed.Type;

// `paths` are relative to the root (clone: to both roots). Without
// them the reads walk the whole tree under the root, the root included
// as ".", and clone and cloneable answer for the root itself.
type Target = {
  readonly root: string;
  readonly paths?: readonly string[] | undefined;
};

export class NativeFs extends Context.Service<
  NativeFs,
  {
    // A copy-on-write clone of each tree, keeping each entry's mode and
    // mtime. A destination must not exist, and its parent must.
    readonly clone: (input: {
      readonly from: string;
      readonly to: string;
      readonly paths?: readonly string[] | undefined;
    }) => Stream.Stream<Entry<typeof Cloned.Type>, NativeFsError>;
    // `a` and `b`, both there on one volume, trade places in one step,
    // so neither path is ever missing.
    // Answers what the call said, a failure among it.
    readonly exchange: (input: {
      readonly a: string;
      readonly b: string;
    }) => Effect.Effect<Entry<typeof Cloned.Type>, NativeFsError>;
    // The file flags a checkout's own files don't carry, as found.
    // `clear` then removes the ones the owner may.
    readonly flags: (
      input: Target & { readonly clear?: boolean | undefined },
    ) => Stream.Stream<Entry<typeof Flags.Type>, NativeFsError>;
    // Extended attribute names as found, but the one the OS stamps on
    // whatever this process writes. `strip` then removes them.
    readonly xattrs: (
      input: Target & { readonly strip?: boolean | undefined },
    ) => Stream.Stream<Entry<typeof Xattrs.Type>, NativeFsError>;
    // lstat(2) of each entry, a symlink's own. `private` adds each
    // regular file's private size, where the volume can tell. A walk
    // steps over the `skip` folders (relative to the root) whole, and a
    // folder it can't list answers twice, in either order: its own entry
    // and a failure for the same path.
    readonly lstat: (
      input: Target & {
        readonly private?: boolean | undefined;
        readonly skip?: ReadonlyArray<string> | undefined;
      },
    ) => Stream.Stream<Entry<typeof Lstat.Type>, NativeFsError>;
    // Whether the volume can clone.
    readonly cloneable: (
      input: Target,
    ) => Stream.Stream<Entry<typeof Cloneability.Type>, NativeFsError>;
  }
>()("sm/engine/NativeFs") {}

export const isFailed = Schema.is(Failed);

// lstat of paths relative to a root, keyed by the relative path. A path
// the helper had no answer for has no key.
export const lstatByPath = (
  nativeFs: NativeFs["Service"],
  root: string,
  paths: ReadonlyArray<string>,
) =>
  paths.length === 0
    ? Effect.succeed(new Map<string, LstatEntry>())
    : nativeFs.lstat({ root, paths }).pipe(
        Stream.runCollect,
        Effect.map(
          (entries) =>
            new Map(
              entries.flatMap((entry) =>
                isFailed(entry) ? [] : [[entry.path, entry] as const],
              ),
            ),
        ),
      );

const encoder = new TextEncoder();

// One NDJSON line: the verb's failure for a path, or its answer there.
// Failure goes first, since a clone's answer is just the path and would
// match a failure's line too.
const lineOf = <F extends Schema.Struct.Fields>(entry: Schema.Struct<F>) =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Union([Failed, entry])),
  );

// `binary` is the helper's path: Resources/nativefs when packaged, the
// build's dist-nativefs/nativefs in dev.
const make = (binary: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // `verb` and its flags, then the roots after a `--`, so a root that
    // starts with a dash stays a root.
    const run = <A>(
      method: NativeFsError["method"],
      verb: readonly string[],
      roots: readonly string[],
      paths: readonly string[] | undefined,
      decodeLine: (line: string) => Effect.Effect<A, Schema.SchemaError>,
    ): Stream.Stream<A, NativeFsError> => {
      const fail = (reason: NativeFsError["reason"]) => (cause: unknown) =>
        new NativeFsError({ method, reason, cause });
      return Stream.unwrap(
        Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(
                binary,
                [...verb, ...(paths ? ["-stdin"] : []), "--", ...roots],
                {
                  stdin: paths
                    ? Stream.make(encoder.encode(paths.join("\0")))
                    : "ignore",
                },
              ),
            )
            .pipe(Effect.mapError(fail("spawn")));
          const stderr = yield* handle.stderr.pipe(
            Stream.decodeText(),
            Stream.mkString,
            Effect.orElseSucceed(() => ""),
            Effect.forkScoped,
          );
          const exited = Effect.gen(function* () {
            const code = yield* handle.exitCode.pipe(
              Effect.mapError(fail("exit")),
            );
            if (code !== 0) {
              const said = yield* Fiber.join(stderr);
              return yield* fail("exit")(
                new Error(`exit ${code}: ${said.trim()}`),
              );
            }
          });
          return handle.stdout.pipe(
            Stream.mapError(fail("output")),
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapEffect((line) =>
              decodeLine(line).pipe(Effect.mapError(fail("output"))),
            ),
            Stream.concat(Stream.fromEffectDrain(exited)),
          );
        }),
      ).pipe(Stream.withSpan(`NativeFs.${method}`));
    };

    return NativeFs.of({
      clone: ({ from, to, paths }) =>
        run("clone", ["clone"], [from, to], paths, lineOf(Cloned)),
      exchange: Effect.fn("NativeFs.exchange")(function* ({ a, b }) {
        const line = yield* run(
          "exchange",
          ["exchange"],
          [a, b],
          undefined,
          lineOf(Cloned),
        ).pipe(Stream.runHead);
        if (Option.isNone(line)) {
          return yield* new NativeFsError({
            method: "exchange",
            reason: "output",
            cause: new Error("no line"),
          });
        }
        return line.value;
      }),
      flags: ({ root, paths, clear }) =>
        run(
          "flags",
          ["flags", ...(clear ? ["-clear"] : [])],
          [root],
          paths,
          lineOf(Flags),
        ),
      xattrs: ({ root, paths, strip }) =>
        run(
          "xattrs",
          ["xattrs", ...(strip ? ["-strip"] : [])],
          [root],
          paths,
          lineOf(Xattrs),
        ),
      lstat: ({ root, paths, private: withPrivate, skip = [] }) =>
        run(
          "lstat",
          [
            "lstat",
            ...(withPrivate ? ["-private"] : []),
            ...skip.flatMap((rel) => ["-skip", rel]),
          ],
          [root],
          paths,
          lineOf(Lstat),
        ),
      cloneable: ({ root, paths }) =>
        run("cloneable", ["cloneable"], [root], paths, lineOf(Cloneability)),
    });
  });

export const layer = (binary: string) => Layer.effect(NativeFs, make(binary));
