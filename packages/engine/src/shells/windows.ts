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
import { cmdReadsIn, isBatchFile } from "../batchFiles.ts";
import { envVar } from "../environment.ts";
import {
  findExecutable,
  joinSearchPath,
  pathExtensions,
} from "../executables.ts";
import { NoScriptShell } from "./documents.ts";

// `nativefs` is the helper a contained sh runs under.
export const makeWindows = Effect.fnUntraced(function* (nativefs: string) {
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

  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const powerShell = yield* Effect.cached(
    Effect.gen(function* () {
      const pwsh = yield* findExecutable("pwsh").pipe(
        Effect.provideContext(platform),
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
        login: false,
      };
    }),
  );

  // One of Git Bash's, started with nothing before its script.
  const shShell = (program: string, env: Readonly<Record<string, string>>) => ({
    program,
    args: [],
    env,
    runArgs: (script: string, args: ReadonlyArray<string> = []) =>
      gitBashShArgs(script, args),
    runCommand: (script: string) => [program, "-c", script],
  });

  const sh = Effect.map(gitBash, ({ usrBin }) =>
    shShell(path.join(usrBin, "sh.exe"), {}),
  );

  return {
    // Not a login shell: a Mac's reads its profile for the PATH there,
    // and on Windows a process already has the user's. What Git Bash's
    // launcher would add, as git gives its hooks: the MSYS2 environment
    // named, and its programs and the POSIX tools first on PATH.
    script: Effect.gen(function* () {
      const { environment, usrBin } = yield* gitBash;
      return shShell(path.join(usrBin, "bash.exe"), {
        MSYSTEM: path.basename(environment).toUpperCase(),
        PATH: joinSearchPath([
          path.join(environment, "bin"),
          usrBin,
          yield* envVar("PATH"),
        ]),
      });
    }),
    findForScript: (name: string) =>
      findForGitBash(name).pipe(Effect.provideContext(platform)),
    interactive: powerShell,
    // PowerShell hands a batch file each argument for cmd to read,
    // quoted only around a space, so one with a character cmd reads
    // (cmdReadsIn) can't go to one.
    untypable: Effect.fnUntraced(function* (
      program: string,
      args: ReadonlyArray<string>,
      what: string,
    ) {
      const read = args.map(cmdReadsIn).find((c) => c !== undefined);
      if (read === undefined) return Option.none<string>();
      const found = yield* findForPowerShell(program).pipe(
        Effect.provideContext(platform),
      );
      return Option.isSome(found) && isBatchFile(found.value)
        ? Option.some(
            `${program} is a batch file (${found.value}), and ${what} can't be passed to it, since cmd would read its ${JSON.stringify(read)}.`,
          )
        : Option.none<string>();
    }),
    sh,
    // Git Bash's sh rewrites an argument that reads as a POSIX path (a
    // commit message `/fix the docs`) for a program not its own, as git
    // is. One named in MSYS2_ARG_CONV_EXCL, a list of prefixes, stays as
    // it is. What the program runs inherits it, and still has its own
    // rewritten unless one starts as one of these.
    containedSh: (script: string, args: ReadonlyArray<string>) =>
      Effect.map(sh, ({ program }) => ({
        program: nativefs,
        args: ["job", program, ...gitBashShArgs(script, args)],
        env: {
          MSYS2_ARG_CONV_EXCL: args
            .filter((arg) => arg.includes("/"))
            .join(";"),
        },
      })),
  };
});

// A package manager's batch file has an sh script beside it, which Git
// Bash runs for the bare name, and which a Ctrl+C ends without cmd's
// "Terminate batch job" prompt.
const findForGitBash = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found = yield* findExecutable(name);
  if (Option.isNone(found) || !isBatchFile(found.value)) return found;
  const script = found.value.slice(0, -path.extname(found.value).length);
  const info = yield* fs.stat(script).pipe(Effect.option);
  return Option.isSome(info) && info.value.type === "File"
    ? Option.some(script)
    : found;
});

// The file PowerShell runs for a bare name: PATH's directories in order,
// and in each a script before PATHEXT's extensions in their order.
const findForPowerShell = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exts = [".ps1", ...(yield* pathExtensions())];
  for (const dir of (yield* envVar("PATH")).split(";")) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return Option.some(candidate);
      }
    }
  }
  return Option.none<string>();
});

// Git Bash's sh reads its own command line from the one Windows hands
// it: it globs what is unquoted there (`@{u}` becomes `@u`, `*` the
// folder's files) and takes a ' as a quote, and Node quotes an argument
// only around a space or a quote. So the script goes as one line, which
// always has a space, behind its arguments set as sh's own ($0 is
// bash's BASH_ARGV0), each quoted for sh. Inside quotes sh reads two
// backslashes as one where Node writes them as they are, except before
// a quote or at the end, so those runs go doubled.
const gitBashShArgs = (
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
