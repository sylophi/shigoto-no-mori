// The program that opens a file, a folder or a link on this machine's
// screen: `open` on a Mac, and xdg-open on a Linux desktop. None on a
// Linux machine with no display (a server reached over SSH), where the
// text browser xdg-open falls back to would run in no terminal.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { envVar } from "./environment.ts";
import { byPlatform } from "./platform.ts";

export const screenOpener = Effect.gen(function* () {
  const display =
    (yield* envVar("DISPLAY")) + (yield* envVar("WAYLAND_DISPLAY"));
  return byPlatform({
    darwin: Option.some("open"),
    linux: display === "" ? Option.none<string>() : Option.some("xdg-open"),
  });
});

// Why nothing opens where there's no screen.
export const NO_SCREEN = "this machine has no screen to open it on";
