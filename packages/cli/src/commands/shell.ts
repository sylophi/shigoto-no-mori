// sm shell <init|install|uninstall|status>: shell integration, so cd
// moves the calling shell instead of nesting a subshell (the engine's
// shellHook says how). And sm cd, which enters a worktree through the
// wrapper's directive file, or in a subshell without one.
import { basename, dirname, join } from "node:path";
import { envVar } from "@shigomori/engine/environment";
import * as Paths from "@shigomori/engine/Paths";
import {
  CD_FILE_ENV,
  cdDirective,
  fishHookContent,
  collapseHome,
  type Hook,
  hookPlace,
  inspectHook,
  isShellKind,
  SHELL_KINDS,
  type ShellKind,
  withHook,
  withoutHook,
  wrapperSnippet,
} from "@shigomori/engine/shellHook";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import { ExitCode, UsageError } from "../errors.ts";
import { given, here, projectFlags } from "../here.ts";
import { emit, note, out, Output, renderTable, styles } from "../output.ts";
import { interactive } from "../prompt.ts";
import { handOver } from "../handOver.ts";

// A hook install or uninstall won't touch, or a config file it couldn't
// read or write. `path` is home-collapsed.
class HookFileError extends Schema.TaggedError<HookFileError>()(
  "HookFileError",
  {
    reason: Schema.Literals([
      "read",
      "create",
      "write",
      "remove",
      "foreign",
      "edited",
      "left",
    ]),
    path: Schema.String,
    // The flavor's command and alias, which Go's words name.
    binary: Schema.String,
    alias: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "read":
        return `Couldn't read ${this.path}.`;
      case "create":
        return `Couldn't create ${this.path}.`;
      case "write":
        return `Couldn't write ${this.path}.`;
      case "remove":
        return `Couldn't remove ${this.path}.`;
      case "foreign":
        return `${this.path} exists but wasn't written by \`${this.binary} shell install\`. Remove it first.`;
      case "edited":
        return `The ${this.alias} block in ${this.path} was edited. Restore or remove it, then install again.`;
      case "left":
        return `Left ${this.path} alone: its ${this.alias} block was edited. Remove it by hand.`;
    }
  }
}

// Where the hooks live, and how a path under home is shown.
const place = Effect.gen(function* () {
  const paths = yield* Paths.Paths;
  return {
    ...hookPlace(paths, yield* envVar("ZDOTDIR")),
    collapse: (target: string) => collapseHome(paths.home, target),
  };
});

type Place = Effect.Success<typeof place>;

const hookError = (
  at: Place,
  reason: HookFileError["reason"],
  target: string,
  cause?: unknown,
) =>
  new HookFileError({
    reason,
    path: at.collapse(target),
    binary: at.names.binary,
    alias: at.names.alias,
    cause,
  });

// The login shell, when it is one sm supports.
const loginShell = Effect.map(envVar("SHELL"), (shell) => {
  const kind = basename(shell);
  return isShellKind(kind) ? kind : "";
});

// The document `shell status --json` prints, and each shell's config
// home-collapsed, in the same order.
const status = Effect.gen(function* () {
  const at = yield* place;
  const shells: Hook[] = [];
  for (const kind of SHELL_KINDS) shells.push(yield* inspectHook(at, kind));
  return {
    document: {
      ok: true,
      loginShell: yield* loginShell,
      active: (yield* envVar(CD_FILE_ENV)) !== "",
      // Hands off an unreadable file as off an edited one.
      shells: shells.map(({ shell, path, state }) => ({
        shell,
        path,
        state: state === "unreadable" ? "modified" : state,
      })),
    },
    shown: shells.map(({ path }) => at.collapse(path)),
  };
});

// Replaces the file whole, through a temp sibling, so a failed write
// never leaves the user's config cut short. An existing file keeps its
// permissions, and a symlinked one (a dotfiles manager's) stays a link,
// the file it points at getting the change.
const writeHookFile = (at: Place, file: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const target = yield* fs
      .realPath(file)
      .pipe(Effect.orElseSucceed(() => file));
    const mode = yield* fs.stat(target).pipe(
      Effect.map((info) => info.mode & 0o777),
      Effect.orElseSucceed(() => 0o644),
    );
    const temp = join(
      dirname(target),
      `.${basename(target)}.tmp-${process.pid}`,
    );
    yield* fs.writeFileString(temp, content, { mode }).pipe(
      // The mode given is masked by the umask on creation.
      Effect.andThen(fs.chmod(temp, mode)),
      Effect.andThen(fs.rename(temp, target)),
      Effect.tapError(() => fs.remove(temp).pipe(Effect.ignore)),
      Effect.mapError((cause) => hookError(at, "write", target, cause)),
    );
  });

// Installs the shell's hook, and answers where, home-collapsed.
const install = (at: Place, kind: ShellKind) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hook = yield* inspectHook(at, kind);
    if (hook.state === "unreadable") {
      return yield* hookError(at, "read", hook.path, hook.error);
    }
    if (hook.state === "modified") {
      return yield* hookError(
        at,
        kind === "fish" ? "foreign" : "edited",
        hook.path,
      );
    }
    if (kind === "fish") {
      const dir = dirname(hook.path);
      yield* fs
        .makeDirectory(dir, { recursive: true })
        .pipe(Effect.mapError((cause) => hookError(at, "create", dir, cause)));
      yield* writeHookFile(at, hook.path, fishHookContent(at.names));
    } else {
      yield* writeHookFile(at, hook.path, withHook(at.names, kind, hook.text));
    }
    return at.collapse(hook.path);
  });

// Removes the shell's hook, and answers where it was, home-collapsed,
// none when there was none.
const uninstall = (at: Place, kind: ShellKind) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const hook = yield* inspectHook(at, kind);
    switch (hook.state) {
      case "missing":
        return Option.none<string>();
      case "unreadable":
        return yield* hookError(at, "read", hook.path, hook.error);
      case "modified":
        return yield* hookError(at, "left", hook.path);
      case "installed":
        yield* kind === "fish"
          ? fs
              .remove(hook.path)
              .pipe(
                Effect.mapError((cause) =>
                  hookError(at, "remove", hook.path, cause),
                ),
              )
          : writeHookFile(at, hook.path, withoutHook(at.names, hook.text));
        return Option.some(at.collapse(hook.path));
    }
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
      const { names } = yield* place;
      // The snippet ends its own last line.
      yield* out(wrapperSnippet(names, shell).replace(/\n$/, ""));
    }),
).pipe(Command.withDescription("Print the wrapper the hook evals"));

const installCommand = Command.make(
  "install",
  { shell: Argument.String("shell").pipe(Argument.optional) },
  ({ shell }) =>
    Effect.gen(function* () {
      const { binaryName, json, stderrColor } = yield* Effect.service(Output);
      const usage = `Usage: ${binaryName} shell install [<zsh|bash|fish>]`;
      const kind = Option.isSome(shell) ? shell.value : yield* loginShell;
      if (!isShellKind(kind)) {
        return yield* new UsageError({
          problem: Option.isSome(shell)
            ? `Unsupported shell ${JSON.stringify(kind)}. ${usage}`
            : `Couldn't tell your shell from $SHELL. Usage: ${binaryName} shell install <zsh|bash|fish>`,
        });
      }
      const target = yield* install(yield* place, kind);
      if (json) return yield* emit((yield* status).document);
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
    const at = yield* place;
    let removedAny = false;
    let failed = false;
    for (const kind of SHELL_KINDS) {
      const removed = yield* uninstall(at, kind).pipe(Effect.result);
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
      yield* emit((yield* status).document);
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
    const { document: found, shown } = yield* status;
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

export const cdCommand = Command.make(
  "cd",
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
        (!(yield* interactive) && (cdFile === "" || Option.isNone(input.name)))
      ) {
        return yield* new UsageError({
          problem: `This command opens a subshell and needs an interactive terminal. In scripts use cd "$(${binaryName} path <name>)".`,
        });
      }
      // The worktree menu waits for the terminal's menus.
      if (Option.isNone(input.name)) {
        return yield* new UsageError({
          problem: `Name the worktree to enter (see \`${binaryName} list\`).`,
        });
      }
      const at = yield* here;
      const { worktree } = yield* (yield* Worktrees.Worktrees).resolve(at, {
        ref: input.name.value,
        project: Option.getOrUndefined(given(input.project)),
      });
      if (at.current?.worktree.id === worktree.id) {
        const { cyan, dim } = styles(stderrColor);
        return yield* note(
          `Already in ${cyan(worktree.name)} ${dim(`(${worktree.path})`)}.`,
        );
      }
      yield* enter(worktree.name, worktree.path, cdFile);
    }),
).pipe(Command.withDescription("Enter a worktree"));
