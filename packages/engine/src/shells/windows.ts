// Windows' shells. A project's command lines and the engine's sh run in
// the Git Bash that comes with Git for Windows, found from the git on
// PATH, never as a `bash` on PATH, which may be WSL's. A terminal runs
// PowerShell: 7 when it is installed, else the one Windows comes with.
import { shellQuote } from "@shigomori/contracts/lifecycleScripts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { envVar } from "../environment.ts";
import { findExecutable, joinSearchPath } from "../executables.ts";
import { NoScriptShell } from "./documents.ts";

export const makeWindows = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // git's exec path is <install>/<its MSYS2 environment>/libexec/git-core,
  // and Git Bash's bash and sh are in <install>/usr/bin. Those, not the
  // launchers in <install>/bin, which run them as a child of their own.
  // Read once, as PATH is: a process doesn't see a later install's.
  const gitBash = yield* Effect.cached(
    Effect.gen(function* () {
      const execPath = yield* spawner
        .string(ChildProcess.make("git", ["--exec-path"]))
        .pipe(Effect.mapError((cause) => new NoScriptShell({ cause })));
      const environment = path.resolve(execPath.trim(), "..", "..");
      const gitRoot = path.dirname(environment);
      const usrBin = path.join(gitRoot, "usr", "bin");
      const found = yield* fs
        .exists(path.join(usrBin, "bash.exe"))
        .pipe(Effect.orElseSucceed(() => false));
      if (!found) return yield* new NoScriptShell({ gitRoot });
      return { environment, usrBin };
    }),
  );

  const powerShell = yield* Effect.cached(
    Effect.gen(function* () {
      const pwsh = yield* findExecutable("pwsh").pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const program = Option.isSome(pwsh)
        ? pwsh.value
        : path.join(
            yield* envVar("SYSTEMROOT"),
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          );
      return {
        program,
        args: ["-NoLogo"],
        env: {},
        syntax: "powershell" as const,
      };
    }),
  );

  return {
    // Not a login shell: a Mac's reads its profile for the PATH there,
    // and on Windows a process already has the user's. What Git Bash's
    // launcher would add, as git gives its hooks: the MSYS2 environment
    // named, and its programs and the POSIX tools first on PATH.
    script: Effect.gen(function* () {
      const { environment, usrBin } = yield* gitBash;
      return {
        program: path.join(usrBin, "bash.exe"),
        args: [],
        env: {
          MSYSTEM: path.basename(environment).toUpperCase(),
          PATH: joinSearchPath([
            path.join(environment, "bin"),
            usrBin,
            yield* envVar("PATH"),
          ]),
        },
      };
    }),
    interactive: powerShell,
    sh: Effect.map(gitBash, ({ usrBin }) => path.join(usrBin, "sh.exe")),
  };
});

// Git Bash's sh reads its own command line from the one Windows hands
// it: it globs what is unquoted there (`@{u}` becomes `@u`, `*` the
// folder's files) and takes a ' as a quote, and Node quotes an argument
// only around a space or a quote. So the script goes as one line, which
// always has a space, behind its arguments set as sh's own ($0 is
// bash's BASH_ARGV0), each quoted for sh. Inside quotes sh reads two
// backslashes as one where Node writes them as they are, except before
// a quote or at the end, so those runs go doubled.
export const gitBashShArgs = (
  script: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const [zero, ...rest] = args;
  const line = [
    ...(zero === undefined ? [] : [`BASH_ARGV0=${shellQuote(zero)}`]),
    `set -- ${rest.map(shellQuote).join(" ")}`,
    script,
  ].join("; ");
  return ["-c", line.replace(/\\+(?=[^"\\])/g, "$&$&")];
};
