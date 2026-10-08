// Finding a program on PATH, as a shell would: the first regular file
// with an execute bit under one of PATH's directories.
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

// The program's full path, none when PATH has no such program.
export const findExecutable = Effect.fn("findExecutable")(function* (
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const searched = yield* Config.String("PATH").pipe(
    Effect.orElseSucceed(() => ""),
  );
  for (const dir of searched.split(":")) {
    // An empty entry is the working directory.
    const candidate = path.join(dir === "" ? "." : dir, name);
    const runnable = yield* fs.stat(candidate).pipe(
      Effect.map((info) => info.type === "File" && (info.mode & 0o111) !== 0),
      Effect.orElseSucceed(() => false),
    );
    if (runnable) return Option.some(candidate);
  }
  return Option.none<string>();
});
