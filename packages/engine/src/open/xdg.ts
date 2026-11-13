// Linux's desktop to Open (desktop.ts): files go to its screen opener,
// and it has no terminal app sm drives.
import * as Effect from "effect/Effect";
import type { CommandsArea } from "./commands.ts";
import type { Desktop } from "./desktop.ts";
import { LaunchFailed } from "./documents.ts";

// Linux finds its apps on PATH alone (Launchers), never at a path.
const noApp = (label: string) =>
  Effect.fail(
    new LaunchFailed({ label, said: "Linux has no app at a path to open" }),
  );

export const makeXdg = ({ onScreen }: CommandsArea) =>
  Effect.succeed({
    openApp: noApp,
    startApp: noApp,
    // xdg-open goes by the file's type, which hands a script to its
    // editor.
    openFile: (label, file) => onScreen(label, [file]),
    inTerminalApp: (label, command) =>
      Effect.fail(
        new LaunchFailed({
          label,
          said: `Linux has no terminal app for sm to open, so run \`${command}\` in a terminal of your own`,
        }),
      ),
  } satisfies Desktop);
