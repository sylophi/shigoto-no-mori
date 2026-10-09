// What counts as a remote: normalizeRemoteUrl is the judge, the same
// one repo identity uses, so "is a remote" means one thing everywhere:
// a plain path, a `~` path and file:// all name a disk, never a remote.

// The one definition of "a remote a device may be asked to clone": it
// normalizes, and it can't be read as a git option. The clone payload,
// the dialog and the URL handed to another device all ask this.
export function isCloneableRemote(url: string): boolean {
  return !url.trim().startsWith("-") && normalizeRemoteUrl(url) !== null;
}

// `owner/repo`, the way gh names a GitHub repository (an Enterprise
// Managed User's handle carries an underscore). The owner can't start
// with a dash, so it never reads as an option.
const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9_-]*\/([A-Za-z0-9._-]+)$/;

export function isGithubShorthand(source: string): boolean {
  const repo = source.trim().match(GITHUB_SHORTHAND)?.[1];
  return repo !== undefined && repo !== "." && repo !== "..";
}

// The remote `source` names: a GitHub `owner/repo` as its https URL,
// anything else as it is.
export function cloneUrlOf(source: string): string {
  return isGithubShorthand(source)
    ? `https://github.com/${source.trim()}`
    : source;
}

// What the clone takes: a remote, or a GitHub repository by its
// `owner/repo`. Only the clone dialog reads the shorthand: everywhere
// else a string like it is a relative path.
export function isCloneSource(source: string): boolean {
  return isCloneableRemote(cloneUrlOf(source));
}

// Reduces a remote URL to `host/owner/repo`: credentials and port
// stripped, ASCII letters of the host lowercased, a leading `ssh.`
// alias folded off the host, path case preserved, trailing `.git` and
// slashes dropped. Returns null for anything machine-local (plain
// paths, `~` paths, `file://`). Handles all four git syntaxes: scheme
// URLs, scp-style with user, and scp-style WITHOUT a user prefix
// (`github.com:owner/repo` is valid git syntax).
export function normalizeRemoteUrl(url: string): string | null {
  const raw = url.trim();
  if (raw.length === 0) return null;
  const scheme = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  if (scheme) {
    if (scheme[1]?.toLowerCase() === "file") return null;
    const rest = raw.slice(scheme[0].length);
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? "" : rest.slice(slash + 1);
    return joinHostPath(stripPort(stripUser(authority)), path);
  }
  // git's scp-vs-path heuristic: a colon before the first slash means
  // ssh, unless it looks like a Windows drive letter or the URL is an
  // explicit path (`./`, `../`, `/`, `~`).
  if (/^[a-zA-Z]:/.test(raw)) return null;
  if (/^(\.\.?\/|\/|~)/.test(raw)) return null;
  const colon = raw.indexOf(":");
  if (colon === -1) return null;
  const slash = raw.indexOf("/");
  if (slash !== -1 && slash < colon) return null;
  return joinHostPath(stripUser(raw.slice(0, colon)), raw.slice(colon + 1));
}

function stripUser(authority: string): string {
  const at = authority.lastIndexOf("@");
  return at === -1 ? authority : authority.slice(at + 1);
}

function stripPort(host: string): string {
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

// ASCII-only: JS toLowerCase applies Unicode mappings (U+0130 grows a
// combining dot), and hosts with such letters are already outside any
// registrable name. Lower only A-Z so everything else is preserved
// byte-for-byte.
function lowerAsciiHost(host: string): string {
  return host.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function joinHostPath(host: string, path: string): string | null {
  let repo = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (repo.endsWith(".git")) repo = repo.slice(0, -4).replace(/\/+$/, "");
  let folded = lowerAsciiHost(host);
  // `ssh.<host>` is the host's SSH-over-443 alias (github.com publishes
  // ssh.github.com, and GHE mirrors the shape): same repo, one key.
  // Mirrors normalizeHost in host/lib/githubCli/remote.ts.
  if (folded.startsWith("ssh.")) folded = folded.slice(4);
  if (folded.length === 0 || repo.length === 0) return null;
  return `${folded}/${repo}`;
}
