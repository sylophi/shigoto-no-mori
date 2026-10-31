// What asks a person at a terminal, never under --json: a question on
// stderr answered on stdin, or their editor.
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { childEnv } from "@shigomori/engine/processes";
import * as Effect from "effect/Effect";
import { note, Output } from "./output.ts";
import { attachStdin } from "./stdinFd.ts";

export const interactive = Effect.map(
  Effect.service(Output),
  ({ json }) =>
    !json && process.stdin.isTTY === true && process.stderr.isTTY === true,
);

// The editor a person set, $VISUAL before $EDITOR, or "" for none.
export const terminalEditor = () =>
  process.env["VISUAL"] || process.env["EDITOR"] || "";

// `file` in `editor` at this terminal until it quits: why it failed, or
// undefined for a clean exit.
export const runEditor = (editor: string, file: string) => {
  const ran = spawnSync("/bin/sh", ["-c", `${editor} "$0"`, file], {
    stdio: "inherit",
    env: childEnv(process.env),
  });
  return ran.status === 0
    ? undefined
    : `${editor} failed: ${ran.error?.message ?? `exit status ${String(ran.status)}`}`;
};

// A yes or no, no by default. End of input is a no.
export const confirm = (question: string) =>
  Effect.gen(function* () {
    const answer = yield* Effect.callback<string | undefined>((resume) => {
      // Stdin's first reader, as a menu's is (stdinFd.ts).
      attachStdin();
      // A plain line: the terminal stays cooked, so Ctrl-C stops the
      // command rather than answering no.
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
