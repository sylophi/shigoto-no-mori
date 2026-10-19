// --verbose: a line on stderr for every git and gh a command runs, the
// trace Go's vlog printed. The engine's services take the spawner from
// the platform layer, so wrapping it there reaches all of them.
import { basename } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { note } from "./output.ts";

const trace = (command: ChildProcess.Command) => {
  if (!("command" in command)) return Effect.void;
  const name = basename(command.command);
  if (name !== "git" && name !== "gh") return Effect.void;
  const args = command.args.join(" ");
  const cwd = command.options.cwd ?? process.cwd();
  return note(name === "git" ? `[git] ${args} (cwd ${cwd})` : `[gh] ${args}`);
};

export const verboseSpawner = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const inner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) =>
      Effect.andThen(trace(command), inner.spawn(command)),
    );
  }),
);
