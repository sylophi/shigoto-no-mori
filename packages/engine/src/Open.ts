// Opening a worktree in one of its launchers: an installed app (a
// terminal tool through the chosen terminal), the repo's GitHub page, or
// a custom command line. Each open counts toward the row's order.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Config from "./Config.ts";
import * as Launchers from "./Launchers.ts";
import * as Lifecycle from "./Lifecycle.ts";
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
  }
>()("sm/engine/Open") {}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
          ChildProcess.make(program, [...args], { stdin: "ignore" }),
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
  const inTerminal = (
    label: string,
    command: string,
    worktreePath: string,
    entries: ReadonlyArray<Launchers.Launchable>,
  ) =>
    Effect.gen(function* () {
      const chosen = yield* config.get({ kind: "device" }, "terminal").pipe(
        Effect.map(({ value }) => (typeof value === "string" ? value : "")),
        Effect.orElseSucceed(() => ""),
      );
      const installed = entries.find(
        (entry) =>
          entry.kind === "detected" &&
          entry.app.id === chosen &&
          TERMINAL_SCRIPTS[chosen] !== undefined,
      );
      const id = installed === undefined ? DEFAULT_TERMINAL : chosen;
      const terminal = installed?.label ?? "Terminal";
      const { code, output } = yield* ran("osascript", [
        "-e",
        TERMINAL_SCRIPTS[id] ?? "",
        `cd ${shellQuote(worktreePath)}\n${command}`,
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
    yield* usage.record("launcher", "", entry.id);
    return entry;
  });

  return Open.of({ open });
});

export const layer = Layer.effect(Open, make);
