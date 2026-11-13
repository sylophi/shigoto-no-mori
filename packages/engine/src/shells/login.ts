// The user's login shell, on a Mac and on Linux, for scripts and
// terminals alike.
import { loginShellOf } from "@shigomori/contracts/loginShell";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { envVar } from "../environment.ts";

export const makeLogin = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // The user's login shell (contracts' loginShellOf), run as one (no -i)
  // so .zprofile sets PATH up without zsh's interactive init. The
  // account's reading is the GUI case: a process launchd started may
  // carry no $SHELL at all. /bin/sh only when neither names one.
  const accountShell = spawner
    .string(
      ChildProcess.make("/bin/sh", [
        "-c",
        `dscl . -read "/Users/$(id -un)" UserShell 2>/dev/null || getent passwd "$(id -u)" | cut -d: -f7`,
      ]),
    )
    .pipe(
      // Cached for the service's life, so a lookup that never answers
      // must not hold every launch after it.
      Effect.timeout("5 seconds"),
      Effect.map((out) => out.replace(/^UserShell:/, "").trim()),
      Effect.orElseSucceed(() => ""),
    );
  const loginShell = yield* Effect.cached(
    Effect.gen(function* () {
      const found = yield* loginShellOf({
        environment: "own",
        shellVar: yield* envVar("SHELL"),
        account: accountShell,
      });
      return found === ""
        ? { program: "/bin/sh", args: [] }
        : { program: found, args: ["-l"] };
    }),
  );

  return { script: loginShell, interactive: loginShell };
});
