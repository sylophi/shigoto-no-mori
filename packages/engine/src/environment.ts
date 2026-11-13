// Reading the process's environment through Effect's Config.
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { byPlatform } from "./platform.ts";

// An environment variable, empty when unset.
export const envVar = (name: string) =>
  Config.String(name).pipe(Effect.orElseSucceed(() => ""));

// Windows takes a variable's name in any case and keeps the one it was
// set in (`Path`), which a copy of the environment keeps too, so a PATH
// set over that copy is a second one, and node-pty hands a child both.
// Renamed upper case once at start, every copy has one of each.
export const uppercaseEnvNames = () =>
  byPlatform({
    darwin: () => {},
    linux: () => {},
    win32: () => {
      for (const [name, value] of Object.entries(process.env)) {
        if (name === name.toUpperCase()) continue;
        delete process.env[name];
        process.env[name.toUpperCase()] = value;
      }
    },
  })();
