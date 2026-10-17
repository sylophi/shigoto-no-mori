// Opening a worktree in one of its launchers: an installed app (a
// terminal tool through the chosen terminal), the repo's GitHub page, or
// a custom command line. Each open counts toward the row's order. And
// opening one of its files in the editor the device settings name.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "./Config.ts";
import * as Launchers from "./Launchers.ts";
import * as Lifecycle from "./Lifecycle.ts";
import { flavorNames } from "./flavor.ts";
import * as Paths from "./Paths.ts";
import { errnoText, isAbsent } from "./platformErrors.ts";
import { scriptEnv, shellQuote } from "./Lifecycle.ts";
import * as Usage from "./Usage.ts";
import * as Worktrees from "./Worktrees.ts";

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

// The launcher wouldn't open, in the words of what refused.
export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()(
  "LaunchFailed",
  { label: Schema.String, said: Schema.String },
) {
  override get message(): string {
    return `Couldn't open ${this.label}: ${this.said}`;
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
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Couldn't open Shigoto no Mori. Is the app installed?";
  }
}

// The dev build has no installed app: it runs from a checkout.
export class NoDevApp extends Schema.TaggedError<NoDevApp>()("NoDevApp", {}) {
  override get message(): string {
    return "This is the dev CLI; the dev app isn't installed. Run `pnpm dev` in a checkout instead.";
  }
}

// How each terminal runs a command line, as an AppleScript taking it as
// its one argument: into a new window, or into the first one a terminal
// opened as it launched.
const terminalScript = (
  app: string,
  intoNewWindow: string,
  intoLaunchWindow: string,
) => `on run argv
	set cmd to item 1 of argv
	set wasRunning to application "${app}" is running
	tell application "${app}"
		if not wasRunning then
			repeat 100 times
				if (count of windows) > 0 then exit repeat
				delay 0.05
			end repeat
		end if
		if not wasRunning and (count of windows) > 0 then
			${intoLaunchWindow}
		else
			${intoNewWindow}
		end if
		activate
	end tell
end run`;

const TERMINAL_SCRIPTS: Readonly<Record<string, string>> = {
  terminal: terminalScript(
    "Terminal",
    "do script cmd",
    "do script cmd in window 1",
  ),
  iterm: terminalScript(
    "iTerm",
    "tell current session of (create window with default profile) to write text cmd",
    "tell current session of current window to write text cmd",
  ),
  ghostty: terminalScript(
    "Ghostty",
    `set cfg to new surface configuration
			set initial input of cfg to cmd & linefeed
			new window with configuration cfg`,
    `set t to focused terminal of selected tab of front window
			input text cmd to t
			send key "enter" to t`,
  ),
  cmux: `on run argv
	set cmd to item 1 of argv
	tell application "cmux"
		set w to new tab
		select tab w
		input text (cmd & linefeed) to focused terminal of w
		activate
	end tell
end run`,
};

const DEFAULT_TERMINAL = "terminal";

// A path as Go's url.QueryEscape writes it into a deep link.
const queryEscape = (text: string) =>
  encodeURIComponent(text)
    .replaceAll(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replaceAll("%20", "+");

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// A launcher the tool names: its id first, then its label, its id, or
// the part of its id after the colon, letter case aside.
const matching = (
  entries: ReadonlyArray<Launchers.Launchable>,
  tool: string,
) => {
  return (
    entries.find(({ id }) => same(id, tool)) ??
    entries.find(
      ({ id, label }) =>
        same(label, tool) ||
        same(id, tool) ||
        (id.includes(":") && same(id.slice(id.indexOf(":") + 1), tool)),
    )
  );
};

export class Open extends Context.Service<
  Open,
  {
    // Opens the worktree in the launcher `tool` names, and counts it.
    readonly open: (
      located: Worktrees.Located,
      tool: string,
    ) => Effect.Effect<Launchers.Launchable, UnknownLauncher | LaunchFailed>;
    // Runs a command line in the user's chosen terminal, in a folder.
    readonly inTerminal: (
      folder: string,
      command: string,
    ) => Effect.Effect<void, LaunchFailed>;
    // Opens a worktree's file, absolute or relative to its root, in the
    // editor the device settings name, or with its default app while
    // that is unset or no longer installed. Answers the file's path.
    readonly edit: (
      located: Worktrees.Located,
      file: string,
    ) => Effect.Effect<string, MissingFile | NotAFile | LaunchFailed>;
    // Opens (or brings forward) the installed app.
    readonly app: Effect.Effect<void, AppNotOpened | NoDevApp>;
  }
>()("sm/engine/Open") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { flavor } = yield* Paths.Paths;
  const launchers = yield* Launchers.Launchers;
  const lifecycle = yield* Lifecycle.Lifecycle;
  const worktrees = yield* Worktrees.Worktrees;
  const usage = yield* Usage.Usage;
  const config = yield* Config.Config;

  // Runs a program to its end: its exit code, and what it printed.
  const ran = (program: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(program, [...args], {
            stdin: "ignore",
          }),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: 3 },
        );
        return { code, output: `${stdout}${stderr}`.trim() };
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed({ code: -1, output: error.message }),
      ),
    );

  // `open` and the like: done once it exits 0.
  const run = (label: string, program: string, args: ReadonlyArray<string>) =>
    Effect.flatMap(ran(program, args), ({ code, output }) =>
      code === 0
        ? Effect.void
        : Effect.fail(
            new LaunchFailed({
              label,
              said: code === -1 ? output : `exit status ${code}`,
            }),
          ),
    );

  // A terminal tool's command line, run in the user's chosen terminal
  // (Terminal when that one isn't installed or has no script).
  // `entries` are the launchers already read, which say whether the
  // chosen terminal is installed. Without them it is looked up.
  const inTerminal = (
    label: string,
    command: string,
    folder: string,
    entries?: ReadonlyArray<Launchers.Launchable>,
  ) =>
    Effect.gen(function* () {
      const chosen = yield* config.get({ kind: "device" }, "terminal").pipe(
        Effect.map(({ value }) => (typeof value === "string" ? value : "")),
        Effect.orElseSucceed(() => ""),
      );
      const installed =
        TERMINAL_SCRIPTS[chosen] === undefined
          ? undefined
          : entries === undefined
            ? yield* launchers.installed(chosen)
            : entries.find(
                (entry) => entry.kind === "detected" && entry.app.id === chosen,
              );
      const id = installed === undefined ? DEFAULT_TERMINAL : chosen;
      const terminal = installed?.label ?? "Terminal";
      const { code, output } = yield* ran("osascript", [
        "-e",
        TERMINAL_SCRIPTS[id] ?? "",
        `cd ${shellQuote(folder)}\n${command}`,
      ]);
      if (code === 0) return;
      const said = output.includes("(-1743)")
        ? `macOS blocked controlling ${terminal}. Allow it in System Settings > Privacy & Security > Automation, then try again.`
        : output.includes("(-1712)")
          ? `${terminal} didn't answer in time. If macOS asked to let it be controlled, allow that and try again.`
          : `Couldn't open ${terminal}: ${output === "" ? `exit status ${code}` : output}`;
      return yield* new LaunchFailed({ label, said });
    });

  const launch = (
    entry: Launchers.Launchable,
    located: Worktrees.Located,
    entries: ReadonlyArray<Launchers.Launchable>,
  ) =>
    Effect.gen(function* () {
      const where = located.worktree.path;
      switch (entry.kind) {
        case "web":
          return yield* run(entry.label, "open", [entry.url]);
        case "custom": {
          // Started in its own session and left running, the worktree's
          // script variables set.
          const { shell, args } = yield* lifecycle.loginShell;
          const context = yield* worktrees.scriptContext(located);
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(
                  "/bin/sh",
                  [
                    "-c",
                    `"$0" "$@" </dev/null >/dev/null 2>&1 &`,
                    shell,
                    ...args,
                    entry.command,
                  ],
                  {
                    cwd: where,
                    detached: true,
                    extendEnv: true,
                    env: {
                      ...scriptEnv(context, entry.label),
                      SHIGOMORI_WORKSPACE_PATH: where,
                    },
                    stdin: "ignore",
                  },
                ),
              );
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
              where,
              entries,
            );
          }
          if (app.deepLink !== undefined) {
            return yield* run(entry.label, "open", [
              app.deepLink.replaceAll("{path}", queryEscape(where)),
            ]);
          }
          if (app.cli !== undefined && entry.cliOnPath) {
            const { code } = yield* ran(app.cli, [where]);
            if (code === 0) return;
          }
          const bundle = entry.bundle;
          if (bundle === "__finder__") {
            return yield* run(entry.label, "open", [where]);
          }
          if (bundle === undefined) {
            return yield* new LaunchFailed({
              label: entry.label,
              said: `No installed app found for ${app.label}.`,
            });
          }
          // `open --args` only reaches an app as it launches, so this
          // starts a new process each time (-n).
          if (app.openArgs !== undefined && app.openArgs.length > 0) {
            return yield* run(entry.label, "open", [
              "-n",
              "-a",
              bundle,
              "--args",
              ...app.openArgs.map((arg) => arg.replaceAll("{path}", where)),
            ]);
          }
          const name = bundle
            .slice(bundle.lastIndexOf("/") + 1)
            .replace(/\.app$/, "");
          return yield* run(entry.label, "open", ["-a", name, where]);
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
    folder: string,
    command: string,
  ) {
    yield* inTerminal("the terminal", command, folder);
  });

  // An executable's default app runs it, and a file no app claims (a
  // Makefile, often a .ts) has none, so those open in the default text
  // editor (open -t).
  const withDefaultApp = (label: string, file: string, executable: boolean) =>
    Effect.gen(function* () {
      if (!executable && (yield* ran("open", [file])).code === 0) return;
      const { code, output } = yield* ran("open", ["-t", file]);
      if (code === 0) return;
      return yield* new LaunchFailed({
        label,
        said: output === "" ? `exit status ${code}` : output,
      });
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
    const chosen = yield* config.get({ kind: "device" }, "editor").pipe(
      Effect.map(({ value }) => (typeof value === "string" ? value : "")),
      Effect.orElseSucceed(() => ""),
    );
    const entry = (yield* launchers.launchable(located.project)).find(
      (candidate) =>
        candidate.kind === "detected" &&
        candidate.app.id === chosen &&
        candidate.app.editor === true,
    );
    if (entry?.kind !== "detected") {
      yield* withDefaultApp(label, absolute, (info.mode & 0o111) !== 0);
      return absolute;
    }
    const { app } = entry;
    if (app.inTerminal !== undefined) {
      const program = app.inTerminal.trim().split(/\s+/)[0] ?? "";
      yield* inTerminal(label, `${program} ${shellQuote(absolute)}`, where);
      return absolute;
    }
    // The worktree goes along, so the file opens in the window that has
    // it (or a new one for it) rather than the last one used.
    if (app.cli !== undefined && entry.cliOnPath) {
      if ((yield* ran(app.cli, [where, absolute])).code === 0) return absolute;
    }
    const bundle = entry.bundle;
    if (bundle === undefined || bundle === "__finder__") {
      return yield* new LaunchFailed({
        label,
        said: `No installed app found for ${app.label}.`,
      });
    }
    const name = bundle
      .slice(bundle.lastIndexOf("/") + 1)
      .replace(/\.app$/, "");
    yield* run(label, "open", ["-a", name, absolute]);
    return absolute;
  });

  // A cold launch gets this environment, which the app rebuilds at
  // startup.
  const app = Effect.gen(function* () {
    if (flavor === "dev") return yield* new NoDevApp();
    const code = yield* Effect.scoped(
      Effect.flatMap(
        spawner.spawn(
          // The installed app's bundle id, which still finds it renamed
          // or moved.
          ChildProcess.make("open", ["-b", flavorNames(flavor).bundleId], {
            stdin: "ignore",
          }),
        ),
        (handle) => handle.exitCode,
      ),
    ).pipe(Effect.mapError((cause) => new AppNotOpened({ cause })));
    if (code !== 0) {
      return yield* new AppNotOpened({ cause: `exit status ${code}` });
    }
  }).pipe(Effect.withSpan("Open.app"));

  return Open.of({ open, inTerminal: inTerminalAt, edit, app });
});

export const layer = Layer.effect(Open, make);
