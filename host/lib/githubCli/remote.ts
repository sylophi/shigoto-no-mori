import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listRemoteEntries } from "../git/remotes";
import { ttlMapCache, ttlValueCache } from "../util/ttlCache";
import { ghReady } from "./readiness";

// Per-repo gate for any path that would shell out to gh. Without this,
// non-github repos eat the full TanStack retry budget on every worktree
// open: gh exits non-zero with "could not determine OWNER, REPO" and the
// query backs off 1s + 2s + 4s before settling. The cache TTL is short
// because users do occasionally `git remote add` mid-session, but long
// enough that the sidebar + open worktree + repo-config queries all
// share one probe.
const GH_REPO_TTL_MS = 5 * 60_000;

export interface GithubRepoInfo {
  // Hostname only, matched against the gh hosts.yml set.
  host: string;
  // Port for the web URL, empty when none applies. Populated only for
  // https remotes — ssh/git/http ports belong to a different service
  // than the browser would talk to.
  port: string;
  owner: string;
  repo: string;
}

const KNOWN_HOSTS_TTL_MS = 60 * 60_000;

// gh stores logged-in hosts in a top-level YAML map. We only need the
// keys, so a regex over "<host>:" lines is enough — pulling in a YAML
// parser for this would be overkill. github.com is always allowed even
// if the file is missing (most users) or unreadable.
const knownHostsCache = ttlValueCache<Set<string>>(
  KNOWN_HOSTS_TTL_MS,
  async () => {
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
    return hosts;
  },
);

// Mirrors gh's own config-dir precedence: GH_CONFIG_DIR beats
// XDG_CONFIG_HOME beats ~/.config/gh. Diverging from gh here would make
// GHE hosts silently unrecognized for users who set either variable.
function ghHostsPath(): string {
  const override = process.env["GH_CONFIG_DIR"];
  if (override) return join(override, "hosts.yml");
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg) return join(xdg, "gh", "hosts.yml");
  return join(homedir(), ".config", "gh", "hosts.yml");
}

// GitHub publishes ssh.github.com as an SSH-over-443 alias for users
// behind firewalls that block port 22. gh itself resolves it to
// github.com, so we'd hide PR data for valid repos if we matched the
// raw host. The same `ssh.<host>` shape works for GHE setups that
// expose 443 the same way, so the normalization isn't github.com-specific.
function normalizeHost(host: string): string {
  return host.startsWith("ssh.") ? host.slice(4) : host;
}

// Parses a git remote URL into host/owner/repo. Accepts ssh shorthand
// (`git@host:owner/repo`) and any URL with a scheme (https, ssh, git, ...).
// Returns null when the URL isn't shaped like a remote we can resolve.
function parseRemoteUrl(url: string): GithubRepoInfo | null {
  const ssh = url.match(/^[^@\s]+@([^:\s]+):([^/\s]+)\/([^/\s]+)$/);
  if (ssh?.[1] && ssh[2] && ssh[3]) {
    const repo = ssh[3].replace(/\.git$/, "");
    if (repo) {
      return { host: normalizeHost(ssh[1]), port: "", owner: ssh[2], repo };
    }
  }
  // URL handles ports, userinfo, trailing slashes, and non-special
  // schemes (ssh://, git://) without us hand-rolling a regex that
  // gets all of those right.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const rawRepo = segments[1];
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.replace(/\.git$/, "");
  if (!repo) return null;
  return {
    host: normalizeHost(parsed.hostname),
    port: parsed.protocol === "https:" ? parsed.port : "",
    owner,
    repo,
  };
}

// First remote URL whose host matches a known GitHub host. One probe
// covers both the "is this a GitHub repo?" gate (ghReadyForRepo) and
// the web URL builder, since both fire on every worktree open.
const githubRepoCache = ttlMapCache<string, GithubRepoInfo | null>(
  GH_REPO_TTL_MS,
  async (cwd) => {
    const [remotes, hosts] = await Promise.all([
      listRemoteEntries(cwd),
      knownHostsCache.get(),
    ]);
    for (const { url } of remotes) {
      const parsed = parseRemoteUrl(url);
      if (parsed && hosts.has(parsed.host)) return parsed;
    }
    return null;
  },
);

export function getGithubRepoInfo(cwd: string): Promise<GithubRepoInfo | null> {
  return githubRepoCache.get(cwd);
}

// The remote pointing at the repo `url` belongs to, by name. Fetching a
// PR head needs a name, and neither "origin" nor "the first GitHub
// remote" is a safe stand-in: a fork checkout has both the fork and the
// parent as remotes, gh resolves pull requests against the parent, and
// fetching a head from the wrong one lands different code under the
// right branch name. Pass the PR's own URL -- it names the repo gh
// actually answered from.
export async function remoteNameForUrl(
  cwd: string,
  url: string,
): Promise<string | null> {
  const target = parseRemoteUrl(url);
  if (!target) return null;
  for (const entry of await listRemoteEntries(cwd)) {
    const parsed = parseRemoteUrl(entry.url);
    // GitHub treats owner and repo case-insensitively, and a remote
    // typed by hand often disagrees with the API's casing.
    if (
      parsed &&
      parsed.host === target.host &&
      sameName(parsed.owner, target.owner) &&
      sameName(parsed.repo, target.repo)
    ) {
      return entry.name;
    }
  }
  return null;
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function githubRepoUrl(info: GithubRepoInfo): string {
  const host = info.port ? `${info.host}:${info.port}` : info.host;
  return `https://${host}/${info.owner}/${info.repo}`;
}

// Combined gate for read paths: gh itself ready, AND this specific repo
// has a remote gh can resolve. Mutations keep ghReady() so their error
// messages can stay specific.
export async function ghReadyForRepo(cwd: string): Promise<boolean> {
  if (!(await ghReady())) return false;
  return (await getGithubRepoInfo(cwd)) !== null;
}
