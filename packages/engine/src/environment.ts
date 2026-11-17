// Reading the process's environment through Effect's Config.
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { byFamily } from "./platform.ts";

// An environment variable, empty when unset.
export const envVar = (name: string) =>
  Config.String(name).pipe(Effect.orElseSucceed(() => ""));

// Windows takes a variable's name in any case and keeps the one it was
// set in (`Path`), which a copy of the environment keeps too, so a PATH
// set over that copy is a second one, and node-pty hands a child both.
// PATH, the one set over copies, is renamed upper case once at start.
// The rest keep theirs, as Git Bash reads names by case.
export const uppercasePath = () =>
  byFamily({
    posix: () => {},
    windows: () => {
      const path = process.env["PATH"];
      if (path === undefined) return;
      delete process.env["PATH"];
      process.env["PATH"] = path;
    },
  })();
