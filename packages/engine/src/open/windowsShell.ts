// Windows' desktop to Open (desktop.ts): files go to the shell's default
// handlers through the screen opener, programs start on their own, and
// a command line runs in Windows Terminal, else in a PowerShell window.
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Launchers from "../Launchers.ts";
import * as Shells from "../Shells.ts";
import type { CommandsArea } from "./commands.ts";
import type { Desktop } from "./desktop.ts";
import { LaunchFailed } from "./documents.ts";

const WINDOWS_TERMINAL = "windows-terminal";

// The engine spells a path with `/`, which a program can read as a
// switch.
const native = (path: string) => path.replaceAll("/", "\\");

// Windows Terminal splits its arguments into commands at every `;` that
// isn't escaped (`\;`), even inside a folder's name, and reads a `\` in
// a command line as an escape, so a path goes to it with `/`.
const forTerminal = (arg: string) =>
  arg.replaceAll("\\", "/").replaceAll(";", "\\;");

// Text as PowerShell reads it literally: in single quotes, each quote it
// takes for one (the curly ones too) doubled.
const quoted = (text: string) => `'${text.replaceAll(/['‘-‛]/g, "$&$&")}'`;

// A script as -EncodedCommand takes it, which no command line parser
// reads into.
const encoded = (script: string) =>
  Buffer.from(script, "utf16le").toString("base64");

// The command line, typed into PowerShell in the folder. Set as a
// location, since Windows PowerShell can't start in a folder whose name
// has brackets.
const inFolder = (folder: string, command: string) =>
  `Set-Location -LiteralPath ${quoted(native(folder))}\n${command}`;

export const makeWindowsShell = ({ run, onScreen }: CommandsArea) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const launchers = yield* Launchers.Launchers;
    const shells = yield* Shells.Shells;

    // Started detached, so it has no console of ours (nor a window for
    // one) and outlives the engine, and left running.
    const start = (
      label: string,
      program: string,
      args: ReadonlyArray<string>,
    ) =>
      Effect.scoped(
        Effect.flatMap(
          spawner.spawn(
            ChildProcess.make(program, args, {
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          ),
          (handle) => Effect.asVoid(handle.unref),
        ),
      ).pipe(
        Effect.mapError(
          (error) => new LaunchFailed({ label, said: error.message }),
        ),
      );

    // The terminal's shell, left open after it runs the command line in
    // the folder.
    const shellIn = (folder: string, command: string) =>
      Effect.map(shells.interactive, ({ program, args }) => ({
        program,
        args: [
          ...args,
          "-NoExit",
          "-EncodedCommand",
          encoded(inFolder(folder, command)),
        ],
      }));

    // A new PowerShell window: a console of its own comes only with the
    // shell's start (Start-Process), asked of a PowerShell no one sees.
    const powerShellWindow = Effect.fnUntraced(function* (
      label: string,
      folder: string,
      command: string,
    ) {
      const { program, args } = yield* shellIn(folder, command);
      yield* run(label, program, [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded(
          `Start-Process -FilePath ${quoted(program)} -ArgumentList ${args.map(quoted).join(",")}`,
        ),
      ]);
    });

    return {
      // A terminal opens a folder its own way. Any other program takes
      // it as its argument.
      openApp: (label, found, target) => {
        switch (path.parse(found).name.toLowerCase()) {
          case "wt":
            return start(label, found, ["-d", forTerminal(target)]);
          case "pwsh":
          case "powershell":
            return powerShellWindow(label, target, "");
          default:
            return start(label, found, [native(target)]);
        }
      },
      startApp: start,
      // A file Windows would run opens in its text editor instead.
      openFile: (label, file, runnable) =>
        runnable
          ? start(label, "notepad.exe", [native(file)])
          : onScreen(label, [native(file)]),
      // The command line in a new tab of Windows Terminal, run by the
      // terminal's shell, or in a PowerShell window where PowerShell is
      // chosen or Windows Terminal isn't installed.
      inTerminalApp: Effect.fnUntraced(
        function* (label, command, folder, chosen, entries) {
          const terminal =
            chosen === "powershell"
              ? undefined
              : entries === undefined
                ? yield* launchers.installed(WINDOWS_TERMINAL)
                : entries.find(
                    (entry) =>
                      entry.kind === "detected" &&
                      entry.app.id === WINDOWS_TERMINAL,
                  );
          if (terminal === undefined) {
            return yield* powerShellWindow(label, folder, command);
          }
          const { program, args } = yield* shellIn(folder, command);
          return yield* start(
            label,
            "wt.exe",
            [program, ...args].map(forTerminal),
          );
        },
      ),
    } satisfies Desktop;
  });
