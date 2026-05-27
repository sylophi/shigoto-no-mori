import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listRemoteUrls } from "../git";
import { ghReady } from "./readiness";

// Per-repo gate for any path that would shell out to gh. Without this,
// non-github repos eat the full TanStack retry budget on every worktree
// open: gh exits non-zero with "could not determine OWNER, REPO" and the
// query backs off 1s + 2s + 4s before settling. The cache TTL is short
// because users do occasionally `git remote add` mid-session, but long
// enough that the sidebar + open worktree + repo-config queries all
// share one probe.
const HAS_GH_REMOTE_TTL_MS = 5 * 60_000;
const hasGithubRemoteCache = new Map<
  string,
  { value: boolean; expires: number }
>();

const KNOWN_HOSTS_TTL_MS = 60 * 60_000;
let knownHostsCache: { value: Set<string>; expires: number } | null = null;

// gh stores logged-in hosts in a top-level YAML map. We only need the
// keys, so a regex over "<host>:" lines is enough — pulling in a YAML
// parser for this would be overkill. github.com is always allowed even
// if the file is missing (most users) or unreadable.
async function getKnownGithubHosts(): Promise<Set<string>> {
  const now = Date.now();
  if (knownHostsCache && knownHostsCache.expires > now) {
    return knownHostsCache.value;
  }
  const hosts = new Set<string>(["github.com"]);
  try {
    const content = await readFile(ghHostsPath(), "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^([^\s:#]+):\s*$/);
      if (m?.[1]) hosts.add(m[1]);
    }
  } catch {
    // hosts.yml may not exist yet (fresh install) or live in an
    // unexpected location; the github.com fallback covers the common case.
  }
  knownHostsCache = { value: hosts, expires: now + KNOWN_HOSTS_TTL_MS };
  return hosts;
}

function ghHostsPath(): string {
  if (process.platform === "win32") {
    return join(process.env["APPDATA"] ?? "", "GitHub CLI", "hosts.yml");
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) return join(xdg, "gh", "hosts.yml");
  return join(homedir(), ".config", "gh", "hosts.yml");
}

function extractHost(url: string): string | null {
  // ssh shorthand "git@host:path" -- no scheme, colon separates host
  // from path rather than acting as a port delimiter.
  const ssh = url.match(/^[^@\s]+@([^:\s]+):/);
  if (ssh?.[1]) return ssh[1];
  // Anything with a scheme: https://, ssh://, git://, etc.
  const u = url.match(/^[a-z]+:\/\/(?:[^@/]+@)?([^/:?\s]+)/i);
  if (u?.[1]) return u[1];
  return null;
}

// GitHub publishes ssh.github.com as an SSH-over-443 alias for users
// behind firewalls that block port 22. gh itself resolves it to
// github.com, so we'd hide PR data for valid repos if we matched the
// raw host. The same `ssh.<host>` shape works for GHE setups that
// expose 443 the same way, so the normalization isn't github.com-specific.
function normalizeHost(host: string): string {
  return host.startsWith("ssh.") ? host.slice(4) : host;
}

async function hasGithubRemote(cwd: string): Promise<boolean> {
  const now = Date.now();
  const cached = hasGithubRemoteCache.get(cwd);
  if (cached && cached.expires > now) return cached.value;
  const [urls, hosts] = await Promise.all([
    listRemoteUrls(cwd),
    getKnownGithubHosts(),
  ]);
  const value = urls.some((url) => {
    const host = extractHost(url);
    return host !== null && hosts.has(normalizeHost(host));
  });
  hasGithubRemoteCache.set(cwd, {
    value,
    expires: now + HAS_GH_REMOTE_TTL_MS,
  });
  return value;
}

// Combined gate for read paths: gh itself ready, AND this specific repo
// has a remote gh can resolve. Mutations keep ghReady() so their error
// messages can stay specific.
export async function ghReadyForRepo(cwd: string): Promise<boolean> {
  if (!(await ghReady())) return false;
  return hasGithubRemote(cwd);
}
