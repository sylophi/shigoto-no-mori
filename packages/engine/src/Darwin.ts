// The macOS filesystem calls Node has no binding for, through the
// bundled helper (macfs/ at the repo root). Each method asks once for
// a whole tree, or for a list of paths, and streams one entry per
// path in no particular order. A path the helper could not answer for
// is an entry with an `error`, not a failure of the stream: the stream
// fails only when the helper itself does.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export class DarwinHelperError extends Schema.TaggedError<DarwinHelperError>()(
  "DarwinHelperError",
  {
    verb: Schema.String,
    reason: Schema.Literals(["spawn", "exit", "output"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `The darwin helper failed to ${this.verb} (${this.reason}).`;
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

// `bytes` is null where the volume cannot say (HFS+, a network mount),
// and the caller counts the allocated size instead.
const PrivateSize = Schema.Struct({
  path: Schema.String,
  bytes: Schema.NullOr(Schema.Int),
});

const FsType = Schema.Struct({
  path: Schema.String,
  type: Schema.String,
});

export type Entry<A> = A | typeof Failed.Type;

// `paths` are relative to the root (clone: to both roots). Without
// them the reads walk the whole tree under the root, the root included
// as ".", and clone and fsType answer for the root itself.
type Target = {
  readonly root: string;
  readonly paths?: readonly string[] | undefined;
};

export class Darwin extends Context.Service<
  Darwin,
  {
    // clonefile(2), keeping each entry's mode and mtime. A destination
    // must not exist, and its parent must.
    readonly clone: (input: {
      readonly from: string;
      readonly to: string;
      readonly paths?: readonly string[] | undefined;
    }) => Stream.Stream<Entry<typeof Cloned.Type>, DarwinHelperError>;
    // st_flags as found. `clear` then removes the owner's flags but
    // compression and tracking.
    readonly flags: (
      input: Target & { readonly clear?: boolean | undefined },
    ) => Stream.Stream<Entry<typeof Flags.Type>, DarwinHelperError>;
    // Extended attribute names as found. `strip` then removes every one
    // but com.apple.provenance, which macOS stamps on whatever this
    // process writes.
    readonly xattrs: (
      input: Target & { readonly strip?: boolean | undefined },
    ) => Stream.Stream<Entry<typeof Xattrs.Type>, DarwinHelperError>;
    // The bytes no clone shares, i.e. what deleting the file would free.
    readonly privateSize: (
      input: Target,
    ) => Stream.Stream<Entry<typeof PrivateSize.Type>, DarwinHelperError>;
    // The filesystem's type name ("apfs", "smbfs").
    readonly fsType: (
      input: Target,
    ) => Stream.Stream<Entry<typeof FsType.Type>, DarwinHelperError>;
  }
>()("sm/engine/Darwin") {}

export const isFailed = Schema.is(Failed);

const encoder = new TextEncoder();

// One NDJSON line: the verb's failure for a path, or its answer there.
// Failure goes first, since a clone's answer is just the path and would
// match a failure's line too.
const lineOf = <F extends Schema.Struct.Fields>(entry: Schema.Struct<F>) =>
  Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Union([Failed, entry])),
  );

// `binary` is the helper's path: Resources/macfs when packaged, the
// build's dist-macfs/macfs in dev.
const make = (binary: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const run = <A>(
      verb: string,
      args: readonly string[],
      paths: readonly string[] | undefined,
      decodeLine: (line: string) => Effect.Effect<A, Schema.SchemaError>,
    ): Stream.Stream<A, DarwinHelperError> => {
      const fail = (reason: DarwinHelperError["reason"]) => (cause: unknown) =>
        new DarwinHelperError({ verb, reason, cause });
      return Stream.unwrap(
        Effect.gen(function* () {
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(
                binary,
                [verb, ...(paths ? ["-stdin"] : []), ...args],
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
      ).pipe(Stream.withSpan(`Darwin.${verb}`));
    };

    return Darwin.of({
      clone: ({ from, to, paths }) =>
        run("clone", [from, to], paths, lineOf(Cloned)),
      flags: ({ root, paths, clear }) =>
        run(
          "flags",
          [...(clear ? ["-clear"] : []), root],
          paths,
          lineOf(Flags),
        ),
      xattrs: ({ root, paths, strip }) =>
        run(
          "xattrs",
          [...(strip ? ["-strip"] : []), root],
          paths,
          lineOf(Xattrs),
        ),
      privateSize: ({ root, paths }) =>
        run("privsize", [root], paths, lineOf(PrivateSize)),
      fsType: ({ root, paths }) => run("fstype", [root], paths, lineOf(FsType)),
    });
  });

export const layer = (binary: string) => Layer.effect(Darwin, make(binary));
