// sm run [<script> [args...]]: the package.json scripts of the worktree
// the cwd is in, listed, or one of them run by the manager its lockfile
// picks, with the SHIGOMORI_* variables, from the worktree's root. The
// app's scripts panel runs scripts the same way, by the ids it holds
// (--project-id, --worktree-id), and reads the list's --json.
//
// The script runs as a child that has the terminal to itself: sm passes
// signals on to it without being ended by them, and ends as it ended,
// killed by its signal included.
import { spawn } from "node:child_process";
import * as Scripts from "@shigomori/engine/Scripts";
import { scriptEnv } from "@shigomori/engine/Lifecycle";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { ExitCode, Killed, UsageError } from "../errors.ts";
import { given, here } from "../here.ts";
import { alignRows, emit, note, out, Output, styles } from "../output.ts";

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

// Where the scripts are: the worktree the app names, else the one at
// the cwd. Running a script somewhere else is the scripts panel's job.
const target = (ids: {
  readonly projectId: Option.Option<string>;
  readonly worktreeId: Option.Option<string>;
}) =>
  Effect.gen(function* () {
    const worktrees = yield* Worktrees.Worktrees;
    const { binaryName } = yield* Effect.service(Output);
    const at = yield* here;
    const worktreeId = given(ids.worktreeId);
    if (Option.isSome(worktreeId)) {
      return yield* worktrees.resolve(at, {
        worktreeId: worktreeId.value,
        projectId: Option.getOrUndefined(given(ids.projectId)),
      });
    }
    if (at.current !== undefined) return at.current;
    if (at.unregisteredRepo !== undefined) {
      return yield* new UsageError({
        problem: `This repo (${at.unregisteredRepo}) isn't registered as a project. Register it with \`${binaryName} projects add\` to run scripts here.`,
      });
    }
    const hint =
      at.projects.length === 0
        ? "No projects are registered yet. Add the repo in the Shigoto no Mori app first."
        : `Registered projects: ${at.projects.map(({ name }) => name).join(", ")}.`;
    return yield* new UsageError({
      problem: `\`${binaryName} run\` only works inside a registered project's checkout or worktree. ${hint}`,
    });
  });

export const runCommand = Command.make(
  "run",
  {
    projectId: Flag.String("project-id").pipe(Flag.optional),
    worktreeId: Flag.String("worktree-id").pipe(Flag.optional),
    args: Argument.String("script").pipe(Argument.variadic()),
  },
  (input) =>
    Effect.gen(function* () {
      const scripts = yield* Scripts.Scripts;
      const { json, binaryName, stdoutColor, stderrColor } =
        yield* Effect.service(Output);
      const { project, worktree } = yield* target(input);
      const [script, ...extra] = input.args;
      const listing = { projectId: project.id, worktreePath: worktree.path };
      if (script === undefined) {
        const listed = yield* scripts.list(listing);
        if (json) return yield* emit({ ok: true, ...listed });
        const dimErr = styles(stderrColor).dim;
        if (listed.scripts.length === 0) {
          return yield* note(dimErr("no scripts in package.json"));
        }
        const { cyan, dim } = styles(stdoutColor);
        for (const line of alignRows(
          listed.scripts.map(({ name, command }) => [cyan(name), dim(command)]),
        )) {
          yield* out(line);
        }
        return yield* note(
          dimErr(
            `runs with ${listed.packageManager}: \`${binaryName} run <script>\``,
          ),
        );
      }
      if (json) {
        // A package.json that can't be read says so first.
        yield* scripts.list(listing);
        return yield* new UsageError({
          problem: `\`${binaryName} run <script>\` hands the terminal to the script. --json only applies to the list form.`,
        });
      }
      const command = yield* scripts.command({ worktree, script, extra });
      const context = yield* (yield* Worktrees.Worktrees).scriptContext({
        project,
        worktree,
      });
      yield* scripts.recordRun(project.id, script);
      // From the worktree's root, not the cwd: a nested package.json must
      // not retarget the run.
      yield* handOver(command.program, command.args, {
        cwd: worktree.path,
        env: { ...process.env, ...scriptEnv(context, script) },
      });
    }),
).pipe(Command.withDescription("List or run the worktree's package scripts"));
