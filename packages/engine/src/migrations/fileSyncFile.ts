import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Paths from "../Paths.ts";
import { isAbsent } from "../platformErrors.ts";
import { SKIPPED } from "./importJson.ts";

const JsonObjectText = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);

// One of the JSON files a 2.x data dir keeps for the mirrors, in
// file-sync/, as an object, for the migration whose table takes it
// over. Absent is none, and so is one that can't be read or parsed,
// which is skipped with a warning: the file stays where it is.
export const fileSyncDocument = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { dataDir } = yield* Paths.Paths;
    const file = path.join(dataDir, "file-sync", name);
    const skipped = Effect.logWarning(SKIPPED).pipe(
      Effect.annotateLogs({ path: file, what: "the file" }),
      Effect.as(Option.none<{ readonly [key: string]: unknown }>()),
    );
    const text = yield* fs.readFileString(file).pipe(
      Effect.map(Option.some),
      Effect.catchIf(isAbsent, () => Effect.succeed(Option.none<string>())),
      Effect.catchTags({
        PlatformError: () => Effect.as(skipped, Option.none<string>()),
      }),
    );
    if (Option.isNone(text)) return Option.none();
    return yield* Schema.decodeUnknownEffect(JsonObjectText)(text.value).pipe(
      Effect.map(Option.some),
      Effect.catchTags({ SchemaError: () => skipped }),
    );
  });
