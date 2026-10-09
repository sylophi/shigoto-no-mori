// sm agents: coding agents' sessions bound to worktrees, and the hooks
// their harnesses report the sessions' state through (the engine's
// Agents). None of these binds the calling session on its own, as
// every other command run in a managed worktree does: they change
// bindings themselves.
import * as Agents from "@shigomori/engine/Agents";
import { HARNESSES } from "@shigomori/engine/agentHooks";
import { shortSession } from "@shigomori/engine/agentSessions";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { UsageError } from "../errors.ts";
import { cwd, given, resolveWorktree, worktreeFlags } from "../here.ts";
import { alignRows, emit, note, out, Output, styles } from "../output.ts";

// No session to act on: neither flags nor a harness's shell name one.
class NoAgentSession extends Schema.TaggedError<NoAgentSession>()(
  "NoAgentSession",
  { verb: Schema.String },
) {
  override get message(): string {
    return `No agent session to ${this.verb}: run this from a supported harness's shell, or pass --harness and --session`;
  }
}

const sessionFlags = {
  harness: Flag.String("harness").pipe(Flag.optional),
  session: Flag.String("session").pipe(Flag.optional),
};

// The session --harness and --session name, or the calling shell's.
const sessionOf = (
  input: {
    readonly harness: Option.Option<string>;
    readonly session: Option.Option<string>;
  },
  verb: string,
) =>
  Effect.gen(function* () {
    const harness = given(input.harness);
    const session = given(input.session);
    if (Option.isSome(harness) !== Option.isSome(session)) {
      return yield* new UsageError({
        problem: "--harness and --session go together.",
      });
    }
    if (Option.isSome(harness) && Option.isSome(session)) {
      return { harness: harness.value, session: session.value };
    }
    const caller = yield* (yield* Agents.Agents).caller;
    if (Option.isNone(caller)) return yield* new NoAgentSession({ verb });
    return caller.value;
  });

const worktreeArgs = {
  ...worktreeFlags,
  ref: Argument.String("worktree").pipe(Argument.optional),
};

const bind = Command.make(
  "bind",
  { ...worktreeArgs, ...sessionFlags },
  (input) =>
    Effect.gen(function* () {
      // The worktree first, as Go did: outside one, that is the error.
      const { located } = yield* resolveWorktree(input, true, false);
      const ref = yield* sessionOf(input, "bind");
      yield* (yield* Agents.Agents).bind(located.worktree, ref);
      const { json, stdoutColor } = yield* Effect.service(Output);
      if (json) {
        return yield* emit({
          ok: true,
          worktree: yield* (yield* Worktrees.Worktrees).row(located),
        });
      }
      yield* out(
        styles(stdoutColor).green(
          `bound ${ref.harness} session ${shortSession(ref.session)} to ${located.worktree.name}`,
        ),
      );
    }),
).pipe(Command.withDescription("Bind an agent session to a worktree"));

const unbind = Command.make("unbind", sessionFlags, (input) =>
  Effect.gen(function* () {
    const ref = yield* sessionOf(input, "unbind");
    const unbound = yield* (yield* Agents.Agents).unbind(ref);
    const { json, stdoutColor } = yield* Effect.service(Output);
    const named = `${ref.harness} session ${shortSession(ref.session)}`;
    yield* json
      ? emit({ ok: true, unbound })
      : out(
          unbound
            ? styles(stdoutColor).green(`unbound ${named}`)
            : `${named} wasn't bound`,
        );
  }),
).pipe(Command.withDescription("Unbind an agent session"));

const idle = Command.make("idle", worktreeArgs, (input) =>
  Effect.gen(function* () {
    const { located } = yield* resolveWorktree(input, true, false);
    yield* (yield* Agents.Agents).idle(located.worktree);
    const { json, stdoutColor } = yield* Effect.service(Output);
    if (json) {
      return yield* emit({
        ok: true,
        worktree: yield* (yield* Worktrees.Worktrees).row(located),
      });
    }
    yield* out(
      styles(stdoutColor).green(
        `agent sessions idle in ${located.worktree.name}`,
      ),
    );
  }),
).pipe(Command.withDescription("Mark a worktree's agent sessions idle"));

const resume = Command.make(
  "resume",
  { ...worktreeArgs, ...sessionFlags },
  (input) =>
    Effect.gen(function* () {
      const { located } = yield* resolveWorktree(input, true, false);
      const harness = given(input.harness);
      const session = given(input.session);
      if (Option.isNone(harness) || Option.isNone(session)) {
        return yield* new UsageError({
          problem: "--harness and --session are required.",
        });
      }
      const ref = { harness: harness.value, session: session.value };
      yield* (yield* Agents.Agents).resume(located, ref);
      const { json, stdoutColor } = yield* Effect.service(Output);
      yield* json
        ? emit({ ok: true })
        : out(
            styles(stdoutColor).green(
              `resumed ${ref.harness} session ${shortSession(ref.session)} in ${located.worktree.name}`,
            ),
          );
    }),
).pipe(Command.withDescription("Resume an agent session in a terminal"));

// What the installed hooks run. Always exits 0 with nothing on stdout:
// a hook's exit code and output are instructions to its harness (2
// blocks the action), and a missed state change must never be one.
const event = Command.make(
  "event",
  { harness: Flag.String("harness").pipe(Flag.optional) },
  (input) =>
    Effect.gen(function* () {
      const harness = given(input.harness);
      if (Option.isNone(harness)) {
        const { binaryName } = yield* Effect.service(Output);
        return yield* note(
          `Usage: ${binaryName} agents event --harness <id> (the event on stdin)`,
        );
      }
      const fs = yield* FileSystem.FileSystem;
      const raw = yield* fs
        .readFileString("/dev/stdin")
        .pipe(Effect.orElseSucceed(() => ""));
      yield* (yield* Agents.Agents).event(harness.value, raw, yield* cwd);
    }),
).pipe(Command.withDescription("Report a session's lifecycle event (stdin)"));

const setHooks = (name: "install" | "uninstall") =>
  Command.make(
    name,
    { harnesses: Argument.String("harness").pipe(Argument.variadic()) },
    (input) =>
      Effect.gen(function* () {
        const install = name === "install";
        const agents = yield* Agents.Agents;
        const done = yield* agents.setHooks(input.harnesses, install);
        const { json, stdoutColor } = yield* Effect.service(Output);
        if (json) {
          return yield* emit({ ok: true, harnesses: yield* agents.statuses });
        }
        const { green, dim, yellow } = styles(stdoutColor);
        for (const harness of done) {
          const trust =
            harness.trusted === false
              ? `\n  ${yellow("Codex runs them once trusted: review them with /hooks in Codex.")}`
              : "";
          yield* out(
            `${green(`${install ? "installed" : "uninstalled"} the ${harness.label} hooks`)}${dim(` (${harness.path})`)}${trust}`,
          );
        }
        if (input.harnesses.length === 0 && done.length === 0) {
          yield* note(
            `No supported harness found (${HARNESSES.map(({ label }) => label).join(", ")}).`,
          );
        }
      }),
  ).pipe(
    Command.withDescription(
      name === "install"
        ? "Install the hooks that report agent sessions"
        : "Remove those hooks",
    ),
  );

const status = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const statuses = yield* (yield* Agents.Agents).statuses;
    const { json, stdoutColor } = yield* Effect.service(Output);
    if (json) return yield* emit({ ok: true, harnesses: statuses });
    const rows = statuses.map((harness) => [
      harness.label,
      !harness.detected
        ? "not found"
        : harness.trusted === false
          ? `${harness.hooks}, untrusted (/hooks in Codex)`
          : harness.hooks,
      styles(stdoutColor).dim(harness.path),
    ]);
    for (const line of alignRows(rows)) yield* out(line);
  }),
).pipe(Command.withDescription("Show each harness's hooks"));

const install = setHooks("install");
const uninstall = setHooks("uninstall");

export const agentsCommand = Command.make("agents").pipe(
  Command.withDescription("Agent integrations: which session works where"),
  Command.withSubcommands([
    install,
    uninstall,
    status,
    bind,
    unbind,
    idle,
    resume,
    event,
  ]),
);
