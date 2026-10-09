// sm shell <init|install|uninstall|status>: shell integration, so cd
// moves the calling shell instead of nesting a subshell (the engine's
// shellHook says how). And sm cd, which enters a worktree through the
// wrapper's directive file, or in a subshell without one.
import { envVar } from "@shigomori/engine/environment";
import * as Paths from "@shigomori/engine/Paths";
import * as ShellIntegration from "@shigomori/engine/ShellIntegration";
import {
  CD_FILE_ENV,
  cdDirective,
  hookPlace,
  isShellKind,
  wrapperSnippet,
} from "@shigomori/engine/shellHook";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import { ExitCode, UsageError } from "../errors.ts";
import { given, here, projectAt, projectFlags } from "../here.ts";
import { emit, note, out, Output, renderTable, styles } from "../output.ts";
import { interactive } from "../prompt.ts";
import { handOver } from "../handOver.ts";
import { pickProject, pickWorktree } from "../pickers.ts";

// The wrapper's names, which init prints.
const names = Effect.gen(function* () {
  return hookPlace(yield* Paths.Paths, "").names;
});

const init = Command.make(
  "init",
  { shell: Argument.String("shell") },
  ({ shell }) =>
    Effect.gen(function* () {
      const { binaryName } = yield* Effect.service(Output);
      if (!isShellKind(shell)) {
        return yield* new UsageError({
          problem: `Unsupported shell ${JSON.stringify(shell)}. Usage: ${binaryName} shell init <zsh|bash|fish>`,
        });
      }
      // The snippet ends its own last line.
      yield* out(wrapperSnippet(yield* names, shell).replace(/\n$/, ""));
    }),
).pipe(Command.withDescription("Print the wrapper the hook evals"));

const installCommand = Command.make(
  "install",
  { shell: Argument.String("shell").pipe(Argument.optional) },
  ({ shell }) =>
    Effect.gen(function* () {
      const { binaryName, json, stderrColor } = yield* Effect.service(Output);
      const usage = `Usage: ${binaryName} shell install [<zsh|bash|fish>]`;
      const integration = yield* ShellIntegration.ShellIntegration;
      const kind = Option.isSome(shell)
        ? shell.value
        : yield* integration.loginShell();
      if (!isShellKind(kind)) {
        return yield* new UsageError({
          problem: Option.isSome(shell)
            ? `Unsupported shell ${JSON.stringify(kind)}. ${usage}`
            : `Couldn't tell your shell from $SHELL. Usage: ${binaryName} shell install <zsh|bash|fish>`,
        });
      }
      const target = yield* integration.install(kind);
      if (json) return yield* emit((yield* integration.status()).document);
      const { cyan, dim } = styles(stderrColor);
      yield* note(
        `Hooked ${cyan(binaryName)} shell integration into ${cyan(target)}.`,
      );
      yield* note(
        dim(
          `Takes effect in new shells. Run \`exec ${kind}\` to reload this one.`,
        ),
      );
    }),
).pipe(
  Command.withDescription("Hook shell integration into your shell config"),
);

// Every shell's config, as it only removes what is recognizably ours:
// covers having switched shells since.
const uninstallCommand = Command.make("uninstall", {}, () =>
  Effect.gen(function* () {
    const { json, stderrColor } = yield* Effect.service(Output);
    const { cyan, dim, yellow } = styles(stderrColor);
    const integration = yield* ShellIntegration.ShellIntegration;
    let removedAny = false;
    let failed = false;
    for (const removed of yield* integration.uninstall()) {
      if (Result.isFailure(removed)) {
        failed = true;
        yield* note(yellow(removed.failure.message));
        continue;
      }
      if (Option.isNone(removed.success)) continue;
      removedAny = true;
      if (!json) {
        yield* note(`Removed the hook from ${cyan(removed.success.value)}.`);
      }
    }
    if (json) {
      yield* emit((yield* integration.status()).document);
    } else if (!removedAny && !failed) {
      yield* note("No shell integration hooks were installed.");
    } else if (removedAny) {
      yield* note(
        dim("Shells already running keep the wrapper until they restart."),
      );
    }
    // Each failure is reported above.
    if (failed) return yield* new ExitCode({ code: 1 });
  }),
).pipe(Command.withDescription("Remove the hook from every shell's config"));

const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const { json, binaryName, stdoutColor } = yield* Effect.service(Output);
    const { document: found, shown } =
      yield* (yield* ShellIntegration.ShellIntegration).status();
    if (json) return yield* emit(found);
    const { dim, green, yellow } = styles(stdoutColor);
    const label = {
      installed: green("installed"),
      modified: yellow("edited"),
      missing: dim("not installed"),
    };
    yield* out(
      renderTable(
        ["shell", "hook", "config"],
        found.shells.map(({ shell, state }, index) => [
          shell === found.loginShell ? `${shell} *` : shell,
          label[state],
          dim(shown[index] ?? ""),
        ]),
        stdoutColor,
      ),
    );
    if (found.loginShell !== "") yield* out(dim("* login shell"));
    if (found.active)
      return yield* out(`Active in this session: ${green("yes")}`);
    yield* found.shells.some(({ state }) => state === "installed")
      ? out(
          `Active in this session: no ${dim("(restart the shell, or it was started before install)")}`,
        )
      : out(
          `Run \`${binaryName} shell install\` to stop cd/create from nesting subshells.`,
        );
  }),
).pipe(Command.withDescription("Show hook and session state"));

// Needs Paths and the platform alone, never the store: init runs in
// every new shell.
export const shellCommand = Command.make("shell").pipe(
  Command.withDescription("Shell integration: cd without subshells"),
  Command.withSubcommands([
    installCommand,
    uninstallCommand,
    statusCommand,
    init,
  ]),
);

// --- sm cd ---

// Moves the user's shell into a worktree: through the wrapper's
// directive file when it gave one, else by starting $SHELL there, whose
// exit sm passes on.
export const enter = (name: string, target: string, cdFile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { stderrColor } = yield* Effect.service(Output);
    const { cyan, dim } = styles(stderrColor);
    const where = `${cyan(name)} ${dim(`(${target})`)}`;
    if (cdFile !== "") {
      const written = yield* fs
        .writeFileString(cdFile, cdDirective(target), { mode: 0o600 })
        .pipe(Effect.isSuccess);
      if (written) return yield* note(`Entering ${where}.`);
      // The subshell still gets them there.
    }
    const shell = (yield* envVar("SHELL")) || "/bin/sh";
    yield* note(`Entering ${where}. Exit the shell to return.`);
    yield* handOver("shell", shell, [], {
      cwd: target,
      env: {
        ...process.env,
        [CD_FILE_ENV]: undefined,
        SHIGOMORI_WORKTREE: name,
      },
    });
  });

// Bare `sm cd` goes anywhere: the project menu first, the current
// project highlighted, unless -p names one or there is only one. Bare
// `sm worktrees switch` stays in the current project.
const menuProject = (
  at: Worktrees.Here,
  project: string | undefined,
  acrossProjects: boolean,
) =>
  acrossProjects && project === undefined && at.projects.length > 1
    ? pickProject(at, at.current?.project.id)
    : projectAt(at, project);

const enterCommand = (
  name: "cd" | "switch",
  acrossProjects: boolean,
  description: string,
) =>
  Command.make(
    name,
    {
      project: projectFlags.project,
      name: Argument.String("worktree").pipe(Argument.optional),
    },
    (input) =>
      Effect.gen(function* () {
        const { json, binaryName, stderrColor } = yield* Effect.service(Output);
        const cdFile = yield* envVar(CD_FILE_ENV);
        // A wrapper's directive file with a name needs no terminal. --json
        // is refused outright: a cd that moves the caller's shell and
        // prints no document would break every NDJSON reader.
        if (
          json ||
          (!(yield* interactive) &&
            (cdFile === "" || Option.isNone(input.name)))
        ) {
          return yield* new UsageError({
            problem: `This command opens a subshell and needs an interactive terminal. In scripts use cd "$(${binaryName} path <name>)".`,
          });
        }
        const at = yield* here;
        const worktrees = yield* Worktrees.Worktrees;
        const project = Option.getOrUndefined(given(input.project));
        const { worktree } = Option.isSome(input.name)
          ? yield* worktrees.resolve(at, { ref: input.name.value, project })
          : yield* pickWorktree(
              at,
              yield* menuProject(at, project, acrossProjects),
              {
                // Entering where you stand isn't a destination.
                excludeId: at.current?.worktree.id,
                primaryOk: true,
              },
            );
        if (at.current?.worktree.id === worktree.id) {
          const { cyan, dim } = styles(stderrColor);
          return yield* note(
            `Already in ${cyan(worktree.name)} ${dim(`(${worktree.path})`)}.`,
          );
        }
        yield* enter(worktree.name, worktree.path, cdFile);
      }),
  ).pipe(Command.withDescription(description));

export const cdCommand = enterCommand("cd", true, "Enter a worktree");

export const switchCommand = enterCommand(
  "switch",
  false,
  "Enter one of this project's worktrees",
);
