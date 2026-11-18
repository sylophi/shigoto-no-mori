// A Mac's desktop to Open (desktop.ts): Launch Services through `open`,
// and terminal apps driven by AppleScript.
import { typedLines } from "@shigomori/contracts/typedLines";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Config from "../Config.ts";
import { flavorNames } from "../flavor.ts";
import * as Paths from "../Paths.ts";
import { openEnvArgs } from "../relaunchEnv.ts";
import type { CommandsArea } from "./commands.ts";
import type { Desktop, LauncherTable } from "./desktop.ts";
import { AppNotOpened, LaunchFailed } from "./documents.ts";

// Where an installed .app can live, in the order they are looked in.
export const appFoldersOf = (path: Path.Path, home: string) => [
  "/Applications",
  path.join(home, "Applications"),
  "/System/Applications",
];

// A Mac finds the catalog's apps by bundle name in its app folders, and
// Finder always.
export const macLaunchers: LauncherTable = {
  placesOf: (app) => app.bundleNames ?? [],
  lookIn: appFoldersOf,
  fileManager: true,
};

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

export const makeLaunchServices = ({ ran, run }: CommandsArea) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const paths = yield* Paths.Paths;
    const config = yield* Config.Config;
    const { appName, bundleId } = flavorNames(paths.flavor);

    return {
      openApp: (label, found, target) =>
        run(label, "open", ["-a", path.basename(found, ".app"), target]),
      // `open --args` only reaches an app as it launches, so this starts a
      // new process each time (-n).
      startApp: (label, found, args) =>
        run(label, "open", ["-n", "-a", found, "--args", ...args]),
      // An executable's default app runs it, and a file no app claims (a
      // Makefile, often a .ts) has none, so those open in the default text
      // editor (open -t).
      openFile: Effect.fnUntraced(function* (label, file, runnable) {
        if (!runnable && (yield* ran("open", [file])).code === 0) return;
        const { code, output } = yield* ran("open", ["-t", file]);
        if (code === 0) return;
        return yield* new LaunchFailed({
          label,
          said: output === "" ? `exit status ${code}` : output,
        });
      }),
      // The command line in a new window of the chosen terminal app,
      // driven by AppleScript.
      inTerminalApp: Effect.fnUntraced(
        function* (label, command, folder, chosen, installed) {
          const app =
            TERMINAL_SCRIPTS[chosen] === undefined
              ? undefined
              : yield* installed(chosen);
          const id = app === undefined ? DEFAULT_TERMINAL : chosen;
          const terminal = app?.label ?? "Terminal";
          const { code, output } = yield* ran("osascript", [
            "-e",
            TERMINAL_SCRIPTS[id] ?? "",
            `${typedLines.posix.cd(folder)}\n${command}`,
          ]);
          if (code === 0) return;
          const said = output.includes("(-1743)")
            ? `macOS blocked controlling ${terminal}. Allow it in System Settings > Privacy & Security > Automation, then try again.`
            : output.includes("(-1712)")
              ? `${terminal} didn't answer in time. If macOS asked to let it be controlled, allow that and try again.`
              : `Couldn't open ${terminal}: ${output === "" ? `exit status ${code}` : output}`;
          return yield* new LaunchFailed({ label, said });
        },
      ),
      terminal: config.device("terminal"),
      // The installed app's bundle, opened by its id, which still finds
      // it renamed or moved.
      openOwnApp: Effect.gen(function* () {
        const { code, output } = yield* ran("open", [
          ...openEnvArgs({
            dataDir: paths.dataDirSource === "env" ? paths.dataDir : undefined,
          }),
          "-b",
          bundleId,
        ]);
        if (code !== 0) {
          return yield* new AppNotOpened({
            appName,
            cause: code === -1 ? output : `exit status ${code}`,
          });
        }
      }),
    } satisfies Desktop;
  });
