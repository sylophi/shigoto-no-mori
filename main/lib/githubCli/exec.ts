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

// Every gh spawn funnels through here. windowsHide: gh.exe is a
// console-subsystem binary, and spawning it from the windowless packaged
// app would otherwise flash a conhost window on every background PR
// sweep.
export function execGh(
  args: string[],
  options: { cwd?: string; maxBuffer?: number; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  // No option spreading: a caller passing `timeout: undefined` would
  // override (and disable) the default -- spread own-properties win
  // even when undefined.
  return execFileP("gh", args, {
    windowsHide: true,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    cwd: options.cwd,
    maxBuffer: options.maxBuffer,
  });
}

// gh's stderr tends to be one long line with a `gh:` prefix; the rest
// is usable as-is. Trim noise so the renderer banner stays compact.
export function trimGhError(raw: string): string {
  const trimmed = raw.trim();
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? trimmed;
  return last.replace(/^gh:\s*/i, "");
}
