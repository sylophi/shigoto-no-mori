// Standard input read to its end, as text, the same way on every OS.
// At a terminal the reader takes the fd held for it (stdinFd.ts).
import * as Effect from "effect/Effect";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { attachStdin } from "./stdinFd.ts";

export const readStdin = Effect.flatMap(Effect.service(Stdio.Stdio), (stdio) =>
  Effect.sync(attachStdin).pipe(
    Effect.andThen(Stream.mkString(Stream.decodeText(stdio.stdin))),
  ),
);
