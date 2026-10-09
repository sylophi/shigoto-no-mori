// Progress on stderr for a long command: animated on a terminal that
// takes escapes, one note per label otherwise, and nothing under --json.
// It clears its line when its scope closes, or sooner with `stop`, so a
// result printed after it starts on a clean line.
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { note, Output, styles } from "./output.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const write = (text: string) => Effect.sync(() => process.stderr.write(text));

export const spinner = Effect.gen(function* () {
  const { json, stderrColor } = yield* Effect.service(Output);
  const label = yield* Ref.make("");
  const set = (next: string) =>
    Effect.flatMap(Ref.getAndSet(label, next), (previous) =>
      !stderrColor && !json && previous !== next ? note(next) : Effect.void,
    );
  if (!stderrColor) return { set, stop: Effect.void };
  const { cyan } = styles(stderrColor);
  const frame = yield* Ref.make(0);
  const draw = Effect.gen(function* () {
    yield* Effect.sleep("80 millis");
    const at = yield* Ref.getAndUpdate(frame, (n) => n + 1);
    const text = yield* Ref.get(label);
    yield* write(
      `\r\u001b[2K${cyan(FRAMES[at % FRAMES.length] ?? "")} ${text}`,
    );
  });
  const running = yield* Ref.make(true);
  const fiber = yield* Effect.forkScoped(Effect.forever(draw));
  const stop = Effect.flatMap(Ref.getAndSet(running, false), (was) =>
    was
      ? Fiber.interrupt(fiber).pipe(Effect.andThen(write("\r\u001b[2K")))
      : Effect.void,
  );
  yield* Effect.addFinalizer(() => stop);
  return { set, stop };
});
