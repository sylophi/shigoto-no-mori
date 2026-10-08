// Handing the terminal to another program, as `sm run` does with a
// script and `sm cd` with a subshell: the program runs as a child, sm
// passes signals on to it without being ended by them, and ends as it
// ended, killed by its signal included.
import { spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ExitCode, Killed } from "./errors.ts";

// A program sm couldn't start.
class StartFailed extends Schema.TaggedError<StartFailed>()("StartFailed", {
  program: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Couldn't start ${this.program}.`;
  }
}

// What sm passes on. At a terminal, the keyboard's signals already
// reached the whole foreground group, the program included, so they
// aren't sent again.
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
const KEYBOARD = new Set<NodeJS.Signals>(["SIGINT", "SIGQUIT", "SIGTSTP"]);

// Runs `program` with the terminal handed to it, and ends as it ended.
// Until it exits, the runtime's own handlers are set aside, so a signal
// sm gets goes to the program and never interrupts sm. SIGTSTP stops sm
// along with it, so the shell's job control sees the stop.
export const handOver = (
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
    const pass = (signal: NodeJS.Signals) => {
      if (!(atTerminal && KEYBOARD.has(signal))) child.kill(signal);
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
      if (settle()) resume(Effect.fail(new StartFailed({ program, cause })));
    });
    child.once("exit", (code, signal) => {
      if (!settle()) return;
      resume(
        Effect.succeed(signal === null ? { code: code ?? 1 } : { signal }),
      );
    });
    return Effect.sync(() => {
      if (settle()) child.kill("SIGTERM");
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
