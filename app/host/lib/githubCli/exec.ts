// Shared `gh` invocation chokepoint. Keep this thin: each caller picks
// its own error policy (swallow vs. throw) and its own JSON projection.
import * as Processes from "../util/processes";

// A wedged gh (proxy auth, SSO browser prompt) must not hang forever:
// the readiness probe gates every PR feature, so one stuck spawn would
// wedge them all. Callers moving real bytes (pr diff) pass a longer
// timeout.
const DEFAULT_TIMEOUT_MS = 30_000;

interface GhOptions {
  readonly cwd?: string;
  readonly maxBuffer?: number;
  readonly timeout?: number;
}

// Every gh spawn funnels through here. Fails with a CommandError.
export const gh = (args: readonly string[], options: GhOptions = {}) =>
  Processes.exec("gh", args, {
    cwd: options.cwd,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    maxOutputBytes: options.maxBuffer,
  });

// gh's stderr tends to be one long line with a `gh:` prefix; the rest
// is usable as-is. Trim noise so the renderer banner stays compact.
export function trimGhError(raw: string): string {
  const trimmed = raw.trim();
  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
  const last = lines[lines.length - 1] ?? trimmed;
  return last.replace(/^gh:\s*/i, "");
}
