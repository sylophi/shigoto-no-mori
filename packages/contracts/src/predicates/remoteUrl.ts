// A plain path, a `~` path and file:// all name a disk, never a remote.

// Normalizes, and can't be read as a git option.
export function isCloneableRemote(url: string): boolean {
  return !url.trim().startsWith("-") && normalizeRemoteUrl(url) !== null;
}

// An Enterprise Managed User's handle carries an underscore. The owner
// can't start with a dash, so it never reads as an option.
const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9_-]*\/([A-Za-z0-9._-]+)$/;

export function isGithubShorthand(source: string): boolean {
  const repo = source.trim().match(GITHUB_SHORTHAND)?.[1];
  return repo !== undefined && repo !== "." && repo !== "..";
}

export function cloneUrlOf(source: string): string {
  return isGithubShorthand(source)
    ? `https://github.com/${source.trim()}`
    : source;
}

// Only the clone dialog reads the shorthand: elsewhere it is a relative
// path.
export function isCloneSource(source: string): boolean {
  return isCloneableRemote(cloneUrlOf(source));
}

// `host/owner/repo`, or null for anything machine-local. scp-style
// without a user (`github.com:owner/repo`) is valid git syntax too.
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
  // git's heuristic: a colon before the first slash means ssh, unless it
  // looks like a drive letter or the URL is an explicit path.
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

// ASCII-only: toLowerCase applies Unicode mappings (U+0130 grows a
// combining dot).
function lowerAsciiHost(host: string): string {
  return host.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function joinHostPath(host: string, path: string): string | null {
  let repo = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (repo.endsWith(".git")) repo = repo.slice(0, -4).replace(/\/+$/, "");
  let folded = lowerAsciiHost(host);
  // The host's SSH-over-443 alias: same repo. Mirrors normalizeHost in
  // host/lib/githubCli/remote.ts.
  if (folded.startsWith("ssh.")) folded = folded.slice(4);
  if (folded.length === 0 || repo.length === 0) return null;
  return `${folded}/${repo}`;
}
