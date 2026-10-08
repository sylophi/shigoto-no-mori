// Handing the terminal to another program, as `sm run` does with a
// script and `sm cd` with a subshell: the program runs as a child, sm
// passes signals on to it without being ended by them, and ends as it
// ended, killed by its signal included.
import { spawn } from "node:child_process";
import { errnoWords } from "@shigomori/engine/platformErrors";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ExitCode, Killed } from "./errors.ts";

// A program sm couldn't start: a script's manager (`exec`, Go's words
// for the exec it did) or a subshell. `reason` is the errno's words.
class StartFailed extends Schema.TaggedError<StartFailed>()("StartFailed", {
  kind: Schema.Literals(["exec", "shell"]),
  program: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.kind === "exec"
      ? `failed to exec ${this.program}: ${this.reason}`
      : `Couldn't start ${this.program}: ${this.reason}`;
  }
}

// What sm passes on.
const PASSED = [
  "SIGINT",
  "SIGQUIT",
  "SIGTERM",
  "SIGHUP",
  "SIGUSR1",
  "SIGUSR2",
  "SIGTSTP",
  "SIGCONT",
] as const;

// At a terminal, these already reached the whole foreground group, the
// program included: the keyboard's from the terminal, SIGHUP from the
// kernel and the shell, SIGCONT from the shell's `fg`. Sending them
// again would deliver each twice (a second Ctrl-C is a forced quit to
// many dev servers). Node can't tell the keyboard's signal from one a
// process sent sm alone with kill(1), so at a terminal that one never
// reaches the program. Whether sm leads the foreground group doesn't
// help: it does in both cases. The app stops a run by its process
// tree, so it isn't affected.
const FROM_TERMINAL = new Set<NodeJS.Signals>([
  "SIGINT",
  "SIGQUIT",
  "SIGTSTP",
  "SIGHUP",
  "SIGCONT",
]);

// How long an interrupted sm gives its program to go after SIGTERM,
// before SIGKILL.
const GRACE = Duration.seconds(3);

// Runs `program` with the terminal handed to it, and ends as it ended.
// Until it exits, the runtime's own handlers are set aside, so a signal
// sm gets goes to the program and never interrupts sm. SIGTSTP stops sm
// along with it, so the shell's job control sees the stop.
export const handOver = (
  kind: StartFailed["kind"],
  program: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
) =>
  Effect.callback<
    { readonly code: number } | { readonly signal: NodeJS.Signals },
    StartFailed
  >((resume) => {
    const atTerminal =
      process.stdin.isTTY === true ||
      process.stdout.isTTY === true ||
      process.stderr.isTTY === true;
    const env = Object.fromEntries(
      Object.entries(options.env).filter(([, value]) => value !== undefined),
    );
    const child = spawn(program, args, {
      cwd: options.cwd,
      env,
      stdio: "inherit",
    });
    // Settles once the child is gone, or never started.
    const gone = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const pass = (signal: NodeJS.Signals) => {
      if (!(atTerminal && FROM_TERMINAL.has(signal))) child.kill(signal);
      if (signal === "SIGTSTP") process.kill(process.pid, "SIGSTOP");
    };
    const set = PASSED.map((signal) => {
      const listeners = process.listeners(signal);
      const listener = () => pass(signal);
      process.removeAllListeners(signal);
      process.on(signal, listener);
      return { signal, listeners, listener };
    });
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      for (const { signal, listeners, listener } of set) {
        process.removeListener(signal, listener);
        for (const kept of listeners) process.on(signal, kept);
      }
      return true;
    };
    child.once("error", (cause) => {
      if (!settle()) return;
      resume(
        Effect.fail(
          new StartFailed({
            kind,
            program,
            reason: errnoWords(cause, cause.message),
            cause,
          }),
        ),
      );
    });
    child.once("exit", (code, signal) => {
      if (!settle()) return;
      resume(
        Effect.succeed(signal === null ? { code: code ?? 1 } : { signal }),
      );
    });
    // Interrupted: the program never outlives sm.
    return Effect.gen(function* () {
      if (!settle()) return;
      child.kill("SIGTERM");
      const waited = yield* Effect.promise(() => gone).pipe(
        Effect.timeoutOption(GRACE),
      );
      if (Option.isSome(waited)) return;
      child.kill("SIGKILL");
      yield* Effect.promise(() => gone);
    });
  }).pipe(
    Effect.flatMap(
      (ended): Effect.Effect<void, ExitCode | Killed> =>
        "signal" in ended
          ? new Killed({ signal: ended.signal })
          : ended.code === 0
            ? Effect.void
            : new ExitCode({ code: ended.code }),
    ),
  );
