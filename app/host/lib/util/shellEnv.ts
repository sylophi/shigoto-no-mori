// macOS hands a GUI app its launcher's environment. From Finder or the
// Dock that is launchd's handful of variables: a stripped PATH and none
// of the additions users keep in .zshrc / .zprofile / Homebrew
// shellenv. From a terminal, or an agent running `open`, it is that
// process's whole environment, agent markers and session tokens
// included, and every process this one spawns (the script runner,
// launchers, git, the CLI) inherits it for the life of the app: a dev
// server started from the app reads as agent-driven because an agent
// happened to launch the app. Neither is what the user's own terminal
// gives a command. So the packaged app rebuilds its environment once at
// startup: what a Finder launch carries, then whatever the user's login
// shell exports, then the overrides a launcher sets for the app itself.
// Every launch then looks the same however it was started, and the
// shell's exports reach every child. Electron-free, so test/shell-env.mts
// drives it under plain node.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { userInfo } from "node:os";
import { log } from "@shared/log";

type Env = Record<string, string>;

// What launchd gives a Finder-launched app, taken from the launch
// environment whichever way the app was started. PATH and SHELL are
// set below, and launchd's own shell-session leftovers (PWD, SHLVL)
// are not kept.
const LAUNCHD_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "XPC_FLAGS",
  "XPC_SERVICE_NAME",
  "COMMAND_MODE",
  "OSLogRateLimit",
  "__CFBundleIdentifier",
  // CoreFoundation's, set in every process on this platform.
  "__CF_USER_TEXT_ENCODING",
] as const;

// launchd's PATH for GUI apps, the one the shell's startup files build
// on (path_helper in /etc/zprofile, then the user's additions).
export const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

// The app's and the CLI's own contract, never a shell profile's to
// set: a Finder launch never saw a profile's SHIGOMORI_* and still
// doesn't, or an export left over from sandboxing the CLI would send
// the app's children (which resolve the data dir themselves,
// the engine's Paths.ts) somewhere the app isn't, and put back an update feed
// stand-in that electron/updateEndpoints.ts took out.
const APP_CONTRACT_PREFIX = "SHIGOMORI_";

// What a launcher sets for the app itself, kept through the rebuild.
// Named one by one, not by prefix: the other SHIGOMORI_* variables
// around are a worktree's (SHIGOMORI_WORKTREE_*,
// SHIGOMORI_WORKSPACE_PATH, the shell wrapper's SHIGOMORI_CD_FILE),
// and an agent working in one would otherwise stamp its worktree onto
// the app for the app's whole life. The dev-only inputs (the debug
// port, the profile) never reach a packaged build. The data dir
// override is inherited by the app's children on purpose (initDataDir
// in host/lib/util/paths.ts).
const LAUNCHER_KEYS = ["SHIGOMORI_DATA_DIR"] as const;

// State of the capture shell's own session, not exports of its startup
// files.
const SHELL_SESSION_KEYS = new Set(["_", "PWD", "OLDPWD", "SHLVL"]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Around the `env -0` block: whatever the startup files print comes
// before START, whatever the logout files print (.zlogout runs after
// the command in a login shell) comes after END.
const START = "__SHIGOMORI_ENV__";
const END = "__SHIGOMORI_ENV_END__";

const MAX_OUTPUT = 4 * 1024 * 1024;

// Same budget as the other login-shell probe (lib/cli/shell.ts).
// Past it the app runs on the Finder-launch environment.
export const CAPTURE_TIMEOUT_MS = 5000;

// How long output may trail the shell's exit.
const EXIT_GRACE_MS = 250;

// The user's login shell, from the user database first: $SHELL is
// whatever the launcher had.
export function loginShell(launchEnv: NodeJS.ProcessEnv): string | null {
  let shell: string | null = null;
  try {
    shell = userInfo().shell;
  } catch {
    // No user database entry, fall through to $SHELL.
  }
  return shell || launchEnv["SHELL"] || null;
}

// The environment a Finder launch would have handed this process:
// launchd's variables out of whatever launch environment this one got.
// SHELL names the shell the capture runs, so a child asking for the
// login shell (the script runner) gets the one whose exports it sees.
export function launchBaseEnv(
  launchEnv: NodeJS.ProcessEnv,
  shell: string | null,
): Env {
  const base: Env = {};
  for (const key of LAUNCHD_KEYS) {
    const value = launchEnv[key];
    if (value !== undefined) base[key] = value;
  }
  base["PATH"] = LAUNCHD_PATH;
  if (shell !== null) base["SHELL"] = shell;
  return base;
}

// The variables between the sentinels, NUL-separated as `env -0`
// prints them, so a multi-line value survives. Null until END is there.
export function parseShellEnv(stdout: string): Env | null {
  const start = stdout.indexOf(START);
  if (start < 0) return null;
  const end = stdout.indexOf(END, start + START.length);
  if (end < 0) return null;
  const env: Env = {};
  for (const entry of stdout.slice(start + START.length, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    // bash exports functions as `BASH_FUNC_name%%=() {...}`: not a
    // variable, and not a name setenv takes.
    if (!ENV_NAME.test(key)) continue;
    env[key] = entry.slice(eq + 1);
  }
  return env;
}

// What an interactive login shell started from `base` exports. -i
// sources the interactive init file (.zshrc / .bashrc) where most users
// put their exports. -l also sources the login files (.zprofile,
// .bash_profile). `command` skips an alias named env. Settles the
// moment END has arrived, not on the shell's exit or its stdout
// closing: a startup file that leaves an agent or a `nohup x &`
// behind leaves the pipe open with it. Null when the shell failed,
// ran out of time, or never reached END. The shell is SIGKILLed
// either way: an interactive zsh ignores SIGTERM. It shares the app's
// process group, so what its startup files left behind is not
// signalled with it.
export const captureShellEnv = (
  shell: string,
  base: Env,
  timeoutMs = CAPTURE_TIMEOUT_MS,
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        shell,
        [
          "-ilc",
          `printf '%s' '${START}'; command env -0; printf '%s' '${END}'`,
        ],
        {
          env: base,
          stdin: "ignore",
          stderr: "ignore",
          detached: false,
          killSignal: "SIGKILL",
        },
      ),
    );
    const read = handle.stdout.pipe(
      Stream.decodeText(),
      Stream.scan(
        () => "",
        (text, chunk) => text + chunk,
      ),
      Stream.takeUntil(
        (text) => text.includes(END) || text.length > MAX_OUTPUT,
      ),
      Stream.runLast,
    );
    // A shell that exits without END may have left a child holding the
    // pipe open, so its exit settles the capture, after a moment for
    // the last of its output.
    const exited = handle.exitCode.pipe(
      Effect.ignore,
      Effect.andThen(Effect.sleep(EXIT_GRACE_MS)),
      Effect.as(Option.none<string>()),
    );
    const output = yield* Effect.raceFirst(read, exited);
    return Option.getOrElse(output, () => "");
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(timeoutMs),
    Effect.map((output) =>
      Option.match(output, {
        onNone: () => null,
        onSome: (text) =>
          text.length > MAX_OUTPUT ? null : parseShellEnv(text),
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

// The rebuilt environment: the base the capture ran from, then the
// shell's exports (its PATH, SSH_AUTH_SOCK, LANG win over launchd's,
// as they do in a terminal) minus the app's own contract, then the
// launcher's overrides for the app. A failed capture leaves the base
// alone: however the app was started, nothing else of its launcher
// gets through.
export function mergeShellEnv(
  base: Env,
  captured: Env | null,
  launchEnv: NodeJS.ProcessEnv,
): Env {
  const env = { ...base };
  for (const [key, value] of Object.entries(captured ?? {})) {
    if (SHELL_SESSION_KEYS.has(key) || key.startsWith(APP_CONTRACT_PREFIX)) {
      continue;
    }
    env[key] = value;
  }
  for (const key of LAUNCHER_KEYS) {
    const value = launchEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// Makes `env` the process environment. Node's process.env writes
// through to the C environ, so Electron's own helper processes see the
// rebuilt one as well as everything spawned from here.
export function replaceProcessEnv(env: Env): void {
  for (const key of Object.keys(process.env)) {
    if (!Object.hasOwn(env, key)) delete process.env[key];
  }
  Object.assign(process.env, env);
}

// The startup entry. Resolves once process.env is rebuilt. The caller
// holds the first spawn until then. Never rejects. It runs before the
// layer graph, which inherits the environment it rebuilds, so it
// brings the platform's services along itself.
export async function applyUserShellEnv(): Promise<void> {
  const launchEnv = { ...process.env };
  const shell = loginShell(launchEnv);
  const base = launchBaseEnv(launchEnv, shell);
  const captured =
    shell === null
      ? null
      : await Effect.runPromise(
          captureShellEnv(shell, base).pipe(Effect.provide(NodeServices.layer)),
        );
  replaceProcessEnv(mergeShellEnv(base, captured, launchEnv));
  if (captured === null) {
    log.warn(
      `[shell] no environment from ${shell ?? "an unknown login shell"}, running on launchd's`,
    );
  } else {
    log.info(`[shell] rebuilt the environment from ${shell}`);
  }
}
