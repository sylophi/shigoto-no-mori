// Shared `gh` invocation chokepoint. Keep this thin: each caller picks
// its own error policy (swallow vs. throw) and its own JSON projection.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ghHostOf } from "./remote";

const execFileP = promisify(execFile);

// A wedged gh (proxy auth, SSO browser prompt) must not hang forever:
// the readiness probe gates every PR feature, so one stuck spawn would
// wedge them all. Callers moving real bytes (pr diff) pass a longer
// timeout.
const DEFAULT_TIMEOUT_MS = 30_000;

// Every gh spawn funnels through here. A run is pinned to `host`, or
// in a repo to the GitHub host gh resolves it on (ghHostOf): `gh api`
// asks github.com otherwise, even in a repo on an Enterprise host.
export async function execGh(
  args: string[],
  options: {
    cwd?: string;
    host?: string;
    maxBuffer?: number;
    timeout?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const host = options.host ?? (options.cwd && (await ghHostOf(options.cwd)));
  // No option spreading: a caller passing `timeout: undefined` would
  // override (and disable) the default. Spread own-properties win
  // even when undefined.
  return execFileP("gh", args, {
    timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
    cwd: options.cwd,
    maxBuffer: options.maxBuffer,
    env: host ? { ...process.env, GH_HOST: host } : undefined,
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
