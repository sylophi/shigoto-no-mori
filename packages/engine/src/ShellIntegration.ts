// Installing, removing and reporting the shell hook (shellHook.ts says
// what it is), for `sm shell` and the app's Settings alike. The rc file
// a hook goes in depends on the shell's ZDOTDIR and XDG_CONFIG_HOME:
// the terminal's are its own environment's, and the app passes its
// login shell's, which a Finder launch doesn't inherit. Needs the data
// dir's names and the platform alone, never the store.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { envVar } from "./environment.ts";
import * as Paths from "./Paths.ts";
import {
  CD_FILE_ENV,
  collapseHome,
  fishHookContent,
  type Hook,
  hookPlace,
  inspectHook,
  isShellKind,
  SHELL_KINDS,
  type ShellKind,
  withHook,
  withoutHook,
} from "./shellHook.ts";

// A hook install or uninstall won't touch, or a config file it couldn't
// read or write. `path` is home-collapsed.
export class HookFileError extends Schema.TaggedError<HookFileError>()(
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

// The shell a hook is for, by what its config's location depends on.
// Each one left out is the process's own.
export type HookShell = {
  readonly zdotdir?: string | undefined;
  readonly configHome?: string | undefined;
  // The login shell's path.
  readonly loginShell?: string | undefined;
};

// The document `shell status --json` prints.
export type StatusDocument = {
  readonly ok: true;
  readonly loginShell: ShellKind | "";
  readonly active: boolean;
  readonly shells: ReadonlyArray<{
    readonly shell: ShellKind;
    readonly path: string;
    readonly state: "installed" | "modified" | "missing";
  }>;
};

export class ShellIntegration extends Context.Service<
  ShellIntegration,
  {
    // The login shell, when it is one sm supports, else "".
    readonly loginShell: (shell?: HookShell) => Effect.Effect<ShellKind | "">;
    // The status document, and each shell's config home-collapsed, in
    // the same order.
    readonly status: (shell?: HookShell) => Effect.Effect<{
      readonly document: StatusDocument;
      readonly shown: ReadonlyArray<string>;
    }>;
    // Installs the shell's hook, and answers where, home-collapsed.
    readonly install: (
      kind: ShellKind,
      shell?: HookShell,
    ) => Effect.Effect<string, HookFileError>;
    // Removes the hook from every shell's config, as it only removes
    // what is recognizably ours: covers having switched shells since.
    // Each shell answers where the hook was (none when there was none),
    // or why it stayed.
    readonly uninstall: (
      shell?: HookShell,
    ) => Effect.Effect<
      ReadonlyArray<Result.Result<Option.Option<string>, HookFileError>>
    >;
  }
>()("sm/engine/ShellIntegration") {}

const make = Effect.gen(function* () {
  const paths = yield* Paths.Paths;
  const fs = yield* FileSystem.FileSystem;
  const { basename, dirname, join } = yield* Path.Path;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  // Where the hooks live, and how a path under home is shown.
  const place = (shell: HookShell = {}) =>
    Effect.gen(function* () {
      const at = hookPlace(paths, shell.zdotdir ?? (yield* envVar("ZDOTDIR")));
      return {
        ...at,
        configHome: shell.configHome || at.configHome,
        collapse: (target: string) => collapseHome(paths.home, target),
      };
    });

  type Place = Effect.Success<ReturnType<typeof place>>;

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

  const loginShell = (shell: HookShell = {}) =>
    Effect.map(
      shell.loginShell === undefined
        ? envVar("SHELL")
        : Effect.succeed(shell.loginShell),
      (path): ShellKind | "" => {
        const kind = basename(path);
        return isShellKind(kind) ? kind : "";
      },
    );

  const status = (shell?: HookShell) =>
    Effect.gen(function* () {
      const at = yield* place(shell);
      const hooks: Hook[] = [];
      for (const kind of SHELL_KINDS) hooks.push(yield* inspectHook(at, kind));
      const document: StatusDocument = {
        ok: true,
        loginShell: yield* loginShell(shell),
        active: (yield* envVar(CD_FILE_ENV)) !== "",
        // Hands off an unreadable file as off an edited one.
        shells: hooks.map(({ shell: kind, path, state }) => ({
          shell: kind,
          path,
          state: state === "unreadable" ? "modified" : state,
        })),
      };
      return { document, shown: hooks.map(({ path }) => at.collapse(path)) };
    });

  // Replaces the file whole, through a temp sibling, so a failed write
  // never leaves the user's config cut short. An existing file keeps
  // its permissions, and a symlinked one (a dotfiles manager's) stays a
  // link, the file it points at getting the change.
  const writeHookFile = (at: Place, file: string, content: string) =>
    Effect.gen(function* () {
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

  const install = Effect.fn("ShellIntegration.install")(function* (
    kind: ShellKind,
    shell?: HookShell,
  ) {
    const at = yield* place(shell);
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

  const uninstallOne = (at: Place, kind: ShellKind) =>
    Effect.gen(function* () {
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

  return ShellIntegration.of({
    loginShell: Effect.fn("ShellIntegration.loginShell")(loginShell),
    status: Effect.fn("ShellIntegration.status")((shell?: HookShell) =>
      status(shell).pipe(Effect.provideContext(platform)),
    ),
    install: (kind, shell) =>
      install(kind, shell).pipe(Effect.provideContext(platform)),
    uninstall: Effect.fn("ShellIntegration.uninstall")(function* (
      shell?: HookShell,
    ) {
      const at = yield* place(shell);
      const results: Array<
        Result.Result<Option.Option<string>, HookFileError>
      > = [];
      for (const kind of SHELL_KINDS) {
        results.push(yield* uninstallOne(at, kind).pipe(Effect.result));
      }
      return results;
    }, Effect.provideContext(platform)),
  });
});

export const layer = Layer.effect(ShellIntegration, make);
