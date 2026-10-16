// --verbose: a line on stderr for every git and gh a command runs, the
// trace Go's vlog printed. The engine's services take the spawner from
// the platform layer, so wrapping it there reaches all of them.
import { basename } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const trace = (command: ChildProcess.Command) => {
  if (!("command" in command)) return;
  const name = basename(command.command);
  if (name !== "git" && name !== "gh") return;
  const args = command.args.join(" ");
  const cwd = command.options.cwd ?? process.cwd();
  process.stderr.write(
    name === "git" ? `[git] ${args} (cwd ${cwd})\n` : `[gh] ${args}\n`,
  );
};

export const verboseSpawner = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const inner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) => {
      trace(command);
      return inner.spawn(command);
    });
  }),
);
