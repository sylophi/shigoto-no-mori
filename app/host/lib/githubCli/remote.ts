// Git remotes read as GitHub repos: host, owner and name from a URL,
// and back from a repo to the remote that points at it.
import { homedir } from "node:os";
import { join } from "node:path";
import { envSetting } from "@shared/config";
import { listRemoteEntries } from "../git/remotes";

export interface GithubRepoInfo {
  // Hostname only, matched against the gh hosts.yml set.
  host: string;
  // Port for the web URL, empty when none applies. Populated only for
  // https remotes, since ssh/git/http ports belong to a different
  // service than the browser would talk to.
  port: string;
  owner: string;
  repo: string;
}

// Mirrors gh's own config-dir precedence: GH_CONFIG_DIR beats
// XDG_CONFIG_HOME beats ~/.config/gh. Diverging from gh here would make
// GHE hosts silently unrecognized for users who set either variable.
export function ghHostsPath(): string {
  const override = envSetting("GH_CONFIG_DIR");
  if (override) return join(override, "hosts.yml");
  const xdg = envSetting("XDG_CONFIG_HOME");
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
export function parseRemoteUrl(url: string): GithubRepoInfo | null {
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

// The remote pointing at the repo `url` belongs to, by name. Fetching a
// PR head needs a name, and neither "origin" nor "the first GitHub
// remote" is a safe stand-in: a fork checkout has both the fork and the
// parent as remotes, gh resolves pull requests against the parent, and
// fetching a head from the wrong one lands different code under the
// right branch name. Pass the PR's own URL. It names the repo gh
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
