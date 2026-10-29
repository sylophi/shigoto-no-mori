// The JSON files a shell writes while it runs (the client config, the
// updater's bridge), on FileSystem: whole-file writes through a temp
// sibling, renamed in, so a reader (the terminal `sm` included) never
// sees one half written, and schema-checked reads. The files the
// Electron shell writes on the way out are main/core/files/exitFiles.ts's.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import {
  type ContractSchema,
  type Decoded,
  decode,
} from "@shigomori/contracts/codec";

// A file the shell keeps that is there but doesn't read or decode.
class JsonFileError extends Schema.TaggedError<JsonFileError>()(
  "JsonFileError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to read ${this.path}`;
  }
}

// The file, or null when it is absent.
export const readJson = <S extends ContractSchema>(path: string, schema: S) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(path))) return null;
    const raw = yield* fs.readFileString(path);
    return yield* Effect.try((): Decoded<S> => decode(schema, JSON.parse(raw)));
  }).pipe(Effect.mapError((cause) => new JsonFileError({ path, cause })));

export const writeJson = (filePath: string, value: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp.${(yield* Random.nextInt).toString(36)}`;
    yield* fs.writeFileString(temp, `${JSON.stringify(value, null, 2)}\n`);
    yield* fs
      .rename(temp, filePath)
      .pipe(Effect.tapError(() => Effect.ignore(fs.remove(temp))));
  });
