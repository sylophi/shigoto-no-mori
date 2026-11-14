// The program that opens a file, a folder or a link on this machine's
// screen, with the arguments it takes before that: `open` on a Mac,
// the shell's default handler on Windows, and xdg-open on a Linux
// desktop. None on a Linux machine with no display (a server reached
// over SSH), where the text browser xdg-open falls back to would run in
// no terminal.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { envVar } from "./environment.ts";
import { byPlatform } from "./platform.ts";

type Opener = {
  readonly program: string;
  readonly args: ReadonlyArray<string>;
};

export const screenOpener = Effect.gen(function* () {
  const display =
    (yield* envVar("DISPLAY")) + (yield* envVar("WAYLAND_DISPLAY"));
  return byPlatform({
    darwin: Option.some<Opener>({ program: "open", args: [] }),
    linux:
      display === ""
        ? Option.none<Opener>()
        : Option.some<Opener>({ program: "xdg-open", args: [] }),
    // rundll32 hands the rest of its command line, read by no shell, to
    // the handler as the one target, so a link's & % # and a path's
    // spaces arrive as they are. It exits 0 whatever the handler does,
    // which shows its own dialog when it fails.
    win32: Option.some<Opener>({
      program: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler"],
    }),
  });
});

// Why nothing opens where there's no screen.
export const NO_SCREEN = "this machine has no screen to open it on";
