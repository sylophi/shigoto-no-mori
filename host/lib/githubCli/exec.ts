// Shared `gh` invocation chokepoint. Keep this thin: each caller picks
// its own error policy (swallow vs. throw) and its own JSON projection.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Effect, Schema } from "effect";
import { classifyExecFailure } from "../util/execFailure";

const execFileP = promisify(execFile);

// A wedged gh (proxy auth, SSO browser prompt) must not hang forever:
// the readiness probe gates every PR feature, so one stuck spawn would
// wedge them all. Callers moving real bytes (pr diff) pass a longer
// timeout.
const DEFAULT_TIMEOUT_MS = 30_000;

export interface GhOptions {
  cwd?: string;
  maxBuffer?: number;
  timeout?: number;
}

export interface GhOutput {
  stdout: string;
  stderr: string;
}

// gh ran and failed: a non-zero exit, a kill by signal (exitCode null),
// or its timeout (`timedOut`, gh's own words, if any, still in
// stderr). Callers read `stderr`, `exitCode` or `timedOut`, never the
// message. A failure to start gh at all is GhSpawnError.
export class GhError extends Schema.TaggedError<GhError>()("GhError", {
  stderr: Schema.String,
  stdout: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  timedOut: Schema.Boolean,
}) {
  // gh's own last line. execFile's message is "Command failed: gh
  // <argv>\n<stderr>", and the argv says nothing a user can act on.
  override get message(): string {
    if (this.timedOut) return "GitHub CLI timed out";
    const said = trimGhError(this.stderr);
    if (said) return said;
    return this.exitCode === null
      ? "gh was stopped before it finished."
      : `gh exited with code ${this.exitCode}.`;
  }
}

// gh never ran: not on the PATH, a cwd that is not there. Node's errno
// is the useful part, kept as an own field so isENOENT reads it.
export class GhSpawnError extends Schema.TaggedError<GhSpawnError>()(
  "GhSpawnError",
  {
    code: Schema.NullOr(Schema.String),
    message: Schema.String,
  },
) {}

export type GhFailure = GhError | GhSpawnError;

// The typed form of an execFile rejection (host/lib/util/execFailure.ts
// sorts it). Node's maxBuffer kill is gh output the app can't hold.
function ghFailure(err: unknown): GhFailure {
  const failure = classifyExecFailure(err);
  switch (failure.kind) {
    case "truncated":
      return new GhError({
        stderr: "gh produced more output than the app can hold.",
        stdout: failure.stdout,
        exitCode: null,
        timedOut: false,
      });
    case "exit":
      return new GhError({
        stderr: failure.stderr,
        stdout: failure.stdout,
        exitCode: failure.exitCode,
        timedOut: failure.killed,
      });
    case "spawn":
      return new GhSpawnError({ code: failure.code, message: failure.message });
  }
}

// One gh run as an Effect: its output, or a typed failure. The fiber's
// interruption kills the child (execFile's signal), so a caller that
// leaves stops gh, and the timeout bounds a run whose caller never does.
export function execGhEffect(
  args: string[],
  options: GhOptions = {},
): Effect.Effect<GhOutput, GhFailure> {
  // No option spreading: a caller passing `timeout: undefined` would
  // override (and disable) the default. Spread own-properties win
  // even when undefined.
  return Effect.tryPromise({
    try: (signal) =>
      execFileP("gh", args, {
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        cwd: options.cwd,
        maxBuffer: options.maxBuffer,
        signal,
      }),
    catch: ghFailure,
  });
}

// Every gh spawn funnels through here (or its Effect form above). It
// rejects with the same GhError / GhSpawnError instances.
export function execGh(
  args: string[],
  options: GhOptions = {},
): Promise<GhOutput> {
  return Effect.runPromise(execGhEffect(args, options));
}

// gh's stderr tends to be one long line with a `gh:` prefix; the rest
// is usable as-is. Trim noise so the renderer banner stays compact.
export function trimGhError(raw: string): string {
  const trimmed = raw.trim();
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? trimmed;
  return last.replace(/^gh:\s*/i, "");
}
