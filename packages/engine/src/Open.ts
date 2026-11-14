// Opening a worktree in one of its launchers: an installed app (a
// terminal tool through the chosen terminal) or a custom command line.
// Each open counts toward the row's order. And opening one of its files
// in the editor the device settings name.
import { scriptEnvOf } from "@shigomori/contracts/scriptEnv";
import type { TerminalId } from "@shigomori/contracts/schemas/launchers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "./Config.ts";
import * as Launchers from "./Launchers.ts";
import { flavorNames } from "./flavor.ts";
import * as Paths from "./Paths.ts";
import { openEnvArgs } from "./relaunchEnv.ts";
import { errnoText, isAbsent } from "./platformErrors.ts";
import { isRunnableMode } from "./executables.ts";
import { byPlatform } from "./platform.ts";
import * as Shells from "./Shells.ts";
import { shellQuote } from "@shigomori/contracts/lifecycleScripts";
import * as Usage from "./Usage.ts";
import * as Worktrees from "./Worktrees.ts";
import { makeCommands } from "./open/commands.ts";
import type { Desktop } from "./open/desktop.ts";
import { LaunchFailed } from "./open/documents.ts";
import { makeLaunchServices } from "./open/launchServices.ts";
import { makeWindowsShell } from "./open/windowsShell.ts";
import { makeXdg } from "./open/xdg.ts";
export { LaunchFailed } from "./open/documents.ts";

// No launcher of the project's goes by `tool`.
export class UnknownLauncher extends Schema.TaggedError<UnknownLauncher>()(
  "UnknownLauncher",
  { tool: Schema.String, labels: Schema.Array(Schema.String) },
) {
  get documentCode(): string {
    return "unknown-launcher";
  }

  override get message(): string {
    return `Unknown tool ${JSON.stringify(this.tool)}. Available: ${this.labels.join(", ")}.`;
  }
}

// No file at the path `edit` was given.
export class MissingFile extends Schema.TaggedError<MissingFile>()(
  "MissingFile",
  { path: Schema.String },
) {
  get documentCode(): string {
    return "missing-file";
  }

  override get message(): string {
    return `No file at ${this.path}.`;
  }
}

// `edit` was given a folder.
export class NotAFile extends Schema.TaggedError<NotAFile>()("NotAFile", {
  path: Schema.String,
}) {
  override get message(): string {
    return `${this.path} is a folder.`;
  }
}

// The app wouldn't open: not installed, or `open` refused.
export class AppNotOpened extends Schema.TaggedError<AppNotOpened>()(
  "AppNotOpened",
  { appName: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't open ${this.appName}. Is the app installed?`;
  }
}

// The dev build has no installed app: it runs from a checkout.
export class NoDevApp extends Schema.TaggedError<NoDevApp>()("NoDevApp", {}) {
  override get message(): string {
    return "This is the dev CLI, and the dev app isn't installed. Run `pnpm dev` in a checkout instead.";
  }
}

// On Linux the app is its host alone, with no window to open.
export class NoAppWindow extends Schema.TaggedError<NoAppWindow>()(
  "NoAppWindow",
  {},
) {
  override get message(): string {
    return "On Linux the app is its host, with no window to open: open this machine from the app on another device.";
  }
}

// Where the installed app is on Windows comes with its installer.
export class NoWindowsApp extends Schema.TaggedError<NoWindowsApp>()(
  "NoWindowsApp",
  {},
) {
  override get message(): string {
    return "sm can't open the app on Windows yet. Open it from the Start menu.";
  }
}

// A path as Go's url.QueryEscape writes it into a deep link.
const queryEscape = (text: string) =>
  encodeURIComponent(text)
    .replaceAll(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replaceAll("%20", "+");

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// A launcher the tool names: its id first, then its label or the part
// of its id after the colon, letter case aside.
const matching = (entries: ReadonlyArray<Launchers.Launchable>, tool: string) =>
  entries.find(({ id }) => same(id, tool)) ??
  entries.find(
    ({ id, label }) =>
      same(label, tool) ||
      (id.includes(":") && same(id.slice(id.indexOf(":") + 1), tool)),
  );

// The worktree's terminal in the app, where a terminal tool's command
// line runs when the `terminal` setting is "app". The app's host
// provides it around its own opens. Without it (the CLI), Terminal
// opens instead.
export class AppTerminal extends Context.Service<
  AppTerminal,
  {
    readonly run: (
      located: Worktrees.Located,
      command: string,
    ) => Effect.Effect<void, Error>;
  }
>()("sm/engine/AppTerminal") {}

export class Open extends Context.Service<
  Open,
  {
    // Opens the worktree in the launcher `tool` names, and counts it.
    readonly open: (
      located: Worktrees.Located,
      tool: string,
    ) => Effect.Effect<Launchers.Launchable, UnknownLauncher | LaunchFailed>;
    // Runs a command line in the user's chosen terminal, or `terminal`
    // when given, in a folder or a worktree (which the app's own
    // terminal can take).
    readonly inTerminal: (
      where: string | Worktrees.Located,
      command: string,
      terminal?: TerminalId,
    ) => Effect.Effect<void, LaunchFailed>;
    // Opens a worktree's file, absolute or relative to its root, in the
    // editor the device settings name, or with its default app while
    // that is unset or no longer installed. Answers the file's path.
    readonly edit: (
      located: Worktrees.Located,
      file: string,
    ) => Effect.Effect<string, MissingFile | NotAFile | LaunchFailed>;
    // Opens (or brings forward) the installed app.
    readonly app: Effect.Effect<
      void,
      AppNotOpened | NoDevApp | NoAppWindow | NoWindowsApp
    >;
  }
>()("sm/engine/Open") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = yield* Paths.Paths;
  const { flavor } = paths;
  const launchers = yield* Launchers.Launchers;
  const shells = yield* Shells.Shells;
  const worktrees = yield* Worktrees.Worktrees;
  const usage = yield* Usage.Usage;
  const config = yield* Config.Config;
  const commands = yield* makeCommands;
  const { ran, onScreen } = commands;
  const desktop: Desktop = yield* byPlatform({
    darwin: makeLaunchServices(commands),
    linux: makeXdg(commands),
    win32: makeWindowsShell(commands),
  });

  // A terminal tool's command line, run in a folder or a worktree in
  // `picked`, else the user's chosen terminal: a worktree's in the app
  // when that is chosen and the app is the one opening, else the chosen
  // terminal app (Terminal when that one isn't installed, or the app's
  // own can't take it). `entries` are the launchers already read, which say
  // whether the chosen terminal is installed. Without them it is
  // looked up. Linux has no terminal app sm drives, so there the app's
  // is the only one.
  const inTerminal = (
    label: string,
    command: string,
    where: string | Worktrees.Located,
    entries?: ReadonlyArray<Launchers.Launchable>,
    picked?: TerminalId,
  ) =>
    Effect.gen(function* () {
      const chosen =
        picked ??
        (yield* byPlatform({
          darwin: config.device("terminal"),
          linux: Effect.succeed("app" as const),
          win32: config.device("terminal"),
        }));
      const appTerminal = yield* Effect.serviceOption(AppTerminal);
      if (
        chosen === "app" &&
        typeof where !== "string" &&
        Option.isSome(appTerminal)
      ) {
        return yield* appTerminal.value
          .run(where, command)
          .pipe(
            Effect.mapError(
              (error) => new LaunchFailed({ label, said: error.message }),
            ),
          );
      }
      const folder = typeof where === "string" ? where : where.worktree.path;
      return yield* desktop.inTerminalApp(
        label,
        command,
        folder,
        chosen,
        entries,
      );
    });

  const launch = (
    entry: Launchers.Launchable,
    located: Worktrees.Located,
    entries: ReadonlyArray<Launchers.Launchable>,
  ) =>
    Effect.gen(function* () {
      const where = located.worktree.path;
      switch (entry.kind) {
        case "custom": {
          // Started in its own session and left running, the worktree's
          // script variables set.
          const { program, args } = yield* shells.script;
          const context = yield* worktrees.scriptContext(located);
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(
                  yield* shells.sh,
                  [
                    "-c",
                    `"$0" "$@" </dev/null >/dev/null 2>&1 &`,
                    program,
                    ...args,
                    "-c",
                    entry.command,
                  ],
                  {
                    cwd: where,
                    detached: true,
                    extendEnv: true,
                    env: {
                      ...scriptEnvOf(context, entry.label),
                      SHIGOMORI_WORKSPACE_PATH: where,
                    },
                    stdin: "ignore",
                  },
                ),
              );
              // Unreferenced, so the scope's close leaves the group the
              // launched command shares with its sh alone.
              yield* Effect.asVoid(handle.unref);
              yield* handle.exitCode;
            }),
          ).pipe(
            Effect.mapError(
              (error) =>
                new LaunchFailed({ label: entry.label, said: error.message }),
            ),
          );
        }
        case "detected": {
          const { app } = entry;
          if (app.inTerminal !== undefined) {
            return yield* inTerminal(
              entry.label,
              app.inTerminal,
              located,
              entries,
            );
          }
          if (app.deepLink !== undefined) {
            return yield* onScreen(entry.label, [
              app.deepLink.replaceAll("{path}", queryEscape(where)),
            ]);
          }
          if (app.cli !== undefined && entry.cliOnPath) {
            const { code } = yield* ran(app.cli, [where]);
            if (code === 0) return;
          }
          const bundle = entry.bundle;
          if (bundle === Launchers.FILE_MANAGER) {
            return yield* onScreen(entry.label, [where]);
          }
          if (bundle === undefined) {
            return yield* new LaunchFailed({
              label: entry.label,
              said: `No installed app found for ${app.label}.`,
            });
          }
          if (app.openArgs !== undefined && app.openArgs.length > 0) {
            return yield* desktop.startApp(
              entry.label,
              bundle,
              app.openArgs.map((arg) => arg.replaceAll("{path}", where)),
            );
          }
          return yield* desktop.openApp(entry.label, bundle, where);
        }
      }
    });

  const open = Effect.fn("Open.open")(function* (
    located: Worktrees.Located,
    tool: string,
  ) {
    const entries = yield* launchers.launchable(located.project);
    const entry = matching(entries, tool);
    if (entry === undefined) {
      return yield* new UnknownLauncher({
        tool,
        labels: entries.map(({ label }) => label),
      });
    }
    yield* launch(entry, located, entries);
    // The launchers' order, best effort: the launch went through.
    yield* usage.record("launcher", "", entry.id).pipe(Effect.ignoreCause);
    return entry;
  });

  const inTerminalAt = Effect.fn("Open.inTerminal")(function* (
    where: string | Worktrees.Located,
    command: string,
    terminal?: TerminalId,
  ) {
    yield* inTerminal("the terminal", command, where, undefined, terminal);
  });

  const edit = Effect.fn("Open.edit")(function* (
    located: Worktrees.Located,
    file: string,
  ) {
    const where = located.worktree.path;
    const absolute = path.resolve(where, file);
    const label = path.basename(absolute);
    const info = yield* fs.stat(absolute).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          isAbsent(error)
            ? Effect.fail(new MissingFile({ path: absolute }))
            : Effect.fail(new LaunchFailed({ label, said: errnoText(error) })),
      }),
    );
    if (info.type === "Directory") {
      return yield* new NotAFile({ path: absolute });
    }
    const chosen = (yield* config.device("editor")) ?? "";
    const entry = (yield* launchers.launchable(located.project)).find(
      (candidate) =>
        candidate.kind === "detected" &&
        candidate.app.id === chosen &&
        candidate.app.editor === true,
    );
    if (entry?.kind !== "detected") {
      yield* desktop.openFile(label, absolute, isRunnableMode(info.mode));
      return absolute;
    }
    const { app } = entry;
    if (app.inTerminal !== undefined) {
      const program = app.inTerminal.trim().split(/\s+/)[0] ?? "";
      yield* inTerminal(label, `${program} ${shellQuote(absolute)}`, located);
      return absolute;
    }
    // The worktree goes along, so the file opens in the window that has
    // it (or a new one for it) rather than the last one used.
    if (app.cli !== undefined && entry.cliOnPath) {
      if ((yield* ran(app.cli, [where, absolute])).code === 0) return absolute;
    }
    const bundle = entry.bundle;
    if (bundle === undefined || bundle === Launchers.FILE_MANAGER) {
      return yield* new LaunchFailed({
        label,
        said: `No installed app found for ${app.label}.`,
      });
    }
    yield* desktop.openApp(label, bundle, absolute);
    return absolute;
  });

  // The installed app's bundle, opened by its id, which still finds it
  // renamed or moved.
  const openBundle = Effect.gen(function* () {
    const code = yield* Effect.scoped(
      Effect.flatMap(
        spawner.spawn(
          ChildProcess.make(
            "open",
            [
              ...openEnvArgs({
                dataDir:
                  paths.dataDirSource === "env" ? paths.dataDir : undefined,
              }),
              "-b",
              flavorNames(flavor).bundleId,
            ],
            { stdin: "ignore" },
          ),
        ),
        (handle) => handle.exitCode,
      ),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new AppNotOpened({ appName: flavorNames(flavor).appName, cause }),
      ),
    );
    if (code !== 0) {
      return yield* new AppNotOpened({
        appName: flavorNames(flavor).appName,
        cause: `exit status ${code}`,
      });
    }
  });

  const app = Effect.gen(function* () {
    if (flavor === "dev") return yield* new NoDevApp();
    return yield* byPlatform({
      darwin: openBundle,
      linux: Effect.fail(new NoAppWindow()),
      win32: Effect.fail(new NoWindowsApp()),
    });
  }).pipe(Effect.withSpan("Open.app"));

  return Open.of({ open, inTerminal: inTerminalAt, edit, app });
});

export const layer = Layer.effect(Open, make);
