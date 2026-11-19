import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Paths from "../Paths.ts";
import { dropsKeys, hintDocument, skip, unknownKeys } from "./importJson.ts";

// One of the JSON files a 2.x data dir keeps for the mirrors, in
// file-sync/, as an object, for the migration whose table takes it
// over. Absent is none, and so is one that can't be read or parsed,
// which is skipped with a warning: the file stays where it is.
export const fileSyncDocument = (name: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const { dataDir } = yield* Paths.Paths;
    return yield* hintDocument(path.join(dataDir, "file-sync", name));
  });

// What a mirror file's migration leaves out, counted as a doubt for the
// import's verification: a key of the document but its version and
// `container`, a `container` of the wrong shape, and an entry `schema`
// refuses or decodes only by dropping a key.
export const countDropped = (
  name: string,
  doc: Option.Option<{ readonly [key: string]: unknown }>,
  container: string,
  entries: ReadonlyArray<unknown>,
  schema: Schema.Decoder<unknown>,
) =>
  Effect.gen(function* () {
    if (Option.isNone(doc)) return;
    const value = doc.value[container];
    const shaped =
      value === undefined ||
      (typeof value === "object" && value !== null && !Array.isArray(value));
    const extra = unknownKeys(doc.value, { schemaVersion: 0, [container]: 0 });
    if (
      !shaped ||
      extra.length > 0 ||
      entries.some(
        (entry) =>
          Option.isNone(Schema.decodeUnknownOption(schema)(entry)) ||
          dropsKeys(schema, entry),
      )
    ) {
      yield* skip(`file-sync/${name}`, container);
    }
  });
