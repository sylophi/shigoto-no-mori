// Finding a program on PATH, as a shell would: the first regular file
// under one of PATH's directories this process may execute.
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { envVar } from "./environment.ts";

// The program's full path, none when PATH has no such program.
export const findExecutable = Effect.fn("findExecutable")(function* (
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const searched = yield* envVar("PATH");
  for (const dir of searched.split(":")) {
    // An empty entry is the working directory.
    const candidate = path.join(dir === "" ? "." : dir, name);
    const runnable =
      (yield* fs.stat(candidate).pipe(
        Effect.map((info) => info.type === "File"),
        Effect.orElseSucceed(() => false),
      )) &&
      (yield* Effect.tryPromise(() => access(candidate, constants.X_OK)).pipe(
        Effect.isSuccess,
      ));
    if (runnable) return Option.some(candidate);
  }
  return Option.none<string>();
});
