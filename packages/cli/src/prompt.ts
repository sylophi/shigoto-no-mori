// Questions to a person at a terminal, the Go sm's way: asked on
// stderr, answered on stdin, never under --json.
import { createInterface } from "node:readline";
import * as Effect from "effect/Effect";
import { note, Output } from "./output.ts";

export const interactive = Effect.map(
  Effect.service(Output),
  ({ json }) =>
    !json && process.stdin.isTTY === true && process.stderr.isTTY === true,
);

// A yes or no, no by default. End of input is a no.
export const confirm = (question: string) =>
  Effect.gen(function* () {
    const answer = yield* Effect.callback<string | undefined>((resume) => {
      // A plain line, as the Go sm read it: the terminal stays cooked, so
      // Ctrl-C stops the command rather than answering no.
      const lines = createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: false,
      });
      let answered = false;
      lines.question(`${question} [y/N] `, (line) => {
        answered = true;
        lines.close();
        resume(Effect.succeed(line));
      });
      lines.on("close", () => {
        if (!answered) resume(Effect.succeed(undefined));
      });
      return Effect.sync(() => lines.close());
    });
    if (answer === undefined) {
      yield* note("");
      return false;
    }
    const said = answer.trim().toLowerCase();
    return said === "y" || said === "yes";
  });
