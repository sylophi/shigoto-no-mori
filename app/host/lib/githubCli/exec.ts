// Shared `gh` invocation chokepoint. Keep this thin: each caller picks
// its own error policy (swallow vs. throw) and its own JSON projection.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// A wedged gh (proxy auth, SSO browser prompt) must not hang forever:
// the readiness probe gates every PR feature, so one stuck spawn would
// wedge them all. Callers moving real bytes (pr diff) pass a longer
// timeout.
const DEFAULT_TIMEOUT_MS = 30_000;

// Every gh spawn funnels through here.
export function execGh(
  args: string[],
  options: { cwd?: string; maxBuffer?: number; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  // No option spreading: a caller passing `timeout: undefined` would
  // override (and disable) the default. Spread own-properties win
  // even when undefined.
  return execFileP("gh", args, {
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    cwd: options.cwd,
    maxBuffer: options.maxBuffer,
    // gh runs git for some commands (a clone, a push), and nobody is at
    // this process's terminal to answer git's credential prompt: one
    // that can't authenticate fails rather than waits.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

// gh's stderr tends to be one long line with a `gh:` prefix; the rest
// is usable as-is. Trim noise so the renderer banner stays compact.
// When git fails under gh, gh's own last line is "failed to run git:
// exit status 128", and git's reason is the `fatal:` line before it.
export function trimGhError(raw: string): string {
  const trimmed = raw.trim();
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? trimmed;
  const fatal = last.startsWith("failed to run git")
    ? lines.findLast((line) => line.startsWith("fatal: "))
    : undefined;
  if (fatal !== undefined) return fatal.slice("fatal: ".length);
  return last.replace(/^gh:\s*/i, "");
}
