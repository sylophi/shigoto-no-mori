// An app gets its launcher's environment. From Finder or the Dock that
// is launchd's handful of variables, and a headless host's unit gets the
// systemd user manager's: a stripped PATH and none of the additions
// users keep in .zshrc / .bashrc / .profile / Homebrew shellenv. From a
// terminal, or an agent running `open`, it is that process's whole
// environment, agent markers and session tokens included, and every
// process this one spawns (the script runner, launchers, git, the CLI)
// inherits it for the life of the app: a dev server started from the
// app reads as agent-driven because an agent happened to launch the
// app. Neither is what the user's own terminal gives a command. So a
// packaged app rebuilds its environment once at startup: what the OS's
// launcher carries, then whatever the user's login shell exports, then
// the overrides a launcher sets for the app itself. Every launch then
// looks the same however it was started, and the shell's exports reach
// every child.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { userInfo } from "node:os";
import { loginShellOf } from "@shigomori/contracts/loginShell";
import { byPlatform } from "@shigomori/engine/platform";
import { log } from "@shared/log";

type Env = Record<string, string>;

// What the OS's launcher gives an app, its variables taken from the
// launch environment whichever way the app was started, and the PATH
// the shell's startup files build on. SHELL is set below, and the
// launcher's own shell-session leftovers (PWD, SHLVL) are not kept.
const LAUNCHER = byPlatform({
  // launchd's, for a Finder-launched app. Its PATH is the one
  // path_helper in /etc/zprofile builds on.
  darwin: {
    keys: [
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
    ],
    path: "/usr/bin:/bin:/usr/sbin:/sbin",
  },
  // The systemd user manager's, for a unit, the base folders the host
  // found its own in as it started among them (Paths). Its PATH is
  // systemd's own.
  linux: {
    keys: [
      "HOME",
      "USER",
      "LOGNAME",
      "LANG",
      "XDG_RUNTIME_DIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "DBUS_SESSION_BUS_ADDRESS",
      "SSH_AUTH_SOCK",
    ],
    path: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  },
});

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
// in shared/paths.ts).
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

// The window waits on the capture, and the app keeps what it gets for
// its whole life. A shell that answers in a tenth of a second can take
// seconds while the machine is still logging in, so the wait is for a
// slow shell, not a typical one. Past it the app runs on the
// launcher's environment.
const CAPTURE_TIMEOUT_MS = 20_000;

// How long output may trail the shell's exit.
const EXIT_GRACE_MS = 250;

// The user's login shell, the account's first: $SHELL is whatever the
// launcher had.
const loginShell = (launchEnv: NodeJS.ProcessEnv) =>
  loginShellOf({
    environment: "launcher",
    shellVar: launchEnv["SHELL"] ?? "",
    account: Effect.try(() => userInfo().shell ?? "").pipe(
      // No user database entry.
      Effect.orElseSucceed(() => ""),
    ),
  }).pipe(Effect.map((shell) => (shell === "" ? null : shell)));

// The environment the OS's launcher would have handed this process:
// its variables out of whatever launch environment this one got.
// SHELL names the shell the capture runs, so a child asking for the
// login shell (the script runner) gets the one whose exports it sees.
function launchBaseEnv(
  launchEnv: NodeJS.ProcessEnv,
  shell: string | null,
): Env {
  const base: Env = {};
  for (const key of LAUNCHER.keys) {
    const value = launchEnv[key];
    if (value !== undefined) base[key] = value;
  }
  base["PATH"] = LAUNCHER.path;
  if (shell !== null) base["SHELL"] = shell;
  return base;
}

// The variables between the sentinels, NUL-separated as `env -0`
// prints them, so a multi-line value survives. Null until END is there.
function parseShellEnv(stdout: string): Env | null {
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

// What a shell printed up to its `end` marker, settled the moment the
// marker arrives, not on the shell's exit or its stdout closing: a
// startup file that leaves an agent or a `nohup x &` behind leaves the
// pipe open with it. None when the shell exited without it (after a
// moment for the last of its output), or said too much first. The
// host's probe of the login shell's config (host/lib/cli/shell.ts)
// reads it too.
export const outputUntil = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  end: string,
) => {
  const read = handle.stdout.pipe(
    Stream.decodeText(),
    Stream.scan(
      () => "",
      (text, chunk) => text + chunk,
    ),
    Stream.takeUntil((text) => text.includes(end) || text.length > MAX_OUTPUT),
    Stream.runLast,
  );
  // A shell that exits without the marker may have left a child holding
  // the pipe open, so its exit settles the read.
  const exited = handle.exitCode.pipe(
    Effect.ignore,
    Effect.andThen(Effect.sleep(EXIT_GRACE_MS)),
    Effect.as(Option.none<string>()),
  );
  return Effect.raceFirst(read, exited).pipe(
    Effect.map(
      Option.filter((text) => text.includes(end) && text.length <= MAX_OUTPUT),
    ),
  );
};

// What an interactive login shell started from `base` exports. -i
// sources the interactive init file (.zshrc / .bashrc) where most users
// put their exports. -l also sources the login files (.zprofile,
// .bash_profile). `command` skips an alias named env. Null when the
// shell failed, ran out of time, or never reached END. The shell is
// SIGKILLed either way: an interactive zsh ignores SIGTERM. It shares
// the app's process group, so what its startup files left behind is
// not signalled with it.
const captureShellEnv = (
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
    return yield* outputUntil(handle, END);
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(timeoutMs),
    Effect.map((output) =>
      Option.match(Option.flatten(output), {
        onNone: () => null,
        onSome: parseShellEnv,
      }),
    ),
    Effect.orElseSucceed(() => null),
  );

// The rebuilt environment: the base the capture ran from, then the
// shell's exports (its PATH, SSH_AUTH_SOCK, LANG win over the
// launcher's, as they do in a terminal) minus the app's own contract, then the
// launcher's overrides for the app. A failed capture leaves the base
// alone: however the app was started, nothing else of its launcher
// gets through.
function mergeShellEnv(
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
function replaceProcessEnv(env: Env): void {
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
  const shell = Effect.runSync(loginShell(launchEnv));
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
      `[shell] no environment from ${shell ?? "an unknown login shell"}, running on the launcher's`,
    );
  } else {
    log.info(`[shell] rebuilt the environment from ${shell}`);
  }
}
