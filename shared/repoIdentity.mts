// Repository identity: decides when the same project on two devices is
// the same repo. Precedence is root commit first, normalized remote URL
// second, null third. That way a fork and its upstream (same root,
// different remotes) share an identity, and a shallow clone (whose
// reported root is fake) still gets a remote-based one. Null is a
// legitimate outcome (no resolvable default ref and no usable remote):
// such a project never merges and stays local to its device, and
// callers MAY cache the null. A git-execution failure (spawn failure,
// non-zero exit outside a probe) rejects instead, so a transient
// failure can never be cached as "no identity".
//
// Pure module: the git runner and the default-ref resolver are
// injected so the renderer and the fixture harness can both load it.
// Ported by hand to cli/identity.go. Keep the two in sync.

import type { GitRunner } from "./defaultBranch.mts";

export interface RepoIdentityDeps {
  run: GitRunner;
  // Fully qualified (`refs/heads/...` / `refs/remotes/...`) so a tag
  // sharing the branch's name can't hijack the rev-list below. null is
  // semantic "no default ref" (falls through to the remote rule). A
  // rejection is a git failure and propagates.
  resolveDefaultRef: (projectPath: string) => Promise<string | null>;
}

export async function computeRepoIdentity(
  projectPath: string,
  deps: RepoIdentityDeps,
): Promise<string | null> {
  const root = await rootCommitKey(projectPath, deps);
  if (root !== null) return root;
  return remoteKey(projectPath, deps.run);
}

// `root:<sha>` of the first-parentless commit reachable from the
// DEFAULT ref (never HEAD, or the key would identify the checkout
// instead of the repo). Three guards, each falling through to the
// remote rule: shallow clones report a fake root, grafted history can
// have several roots (take the lexically first for determinism), and
// the default ref can be unresolvable (no candidate branches, no
// commits). Git failures are NOT guards: they propagate.
async function rootCommitKey(
  projectPath: string,
  deps: RepoIdentityDeps,
): Promise<string | null> {
  const shallow = await deps.run(projectPath, [
    "rev-parse",
    "--is-shallow-repository",
  ]);
  if (shallow.trim() !== "false") return null;
  const ref = await deps.resolveDefaultRef(projectPath);
  if (ref === null) return null;
  const stdout = await deps.run(projectPath, [
    "rev-list",
    "--max-parents=0",
    ref,
    "--",
  ]);
  const roots = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted();
  const first = roots[0];
  return first ? `root:${first}` : null;
}

// `remote:<host/owner/repo>` from the primary fetch remote: `upstream`
// beats `origin` beats the alphabetically-first remote, considering only
// remotes whose URL normalizes (path-style and file:// remotes are
// machine-local, never identity keys).
async function remoteKey(
  projectPath: string,
  run: GitRunner,
): Promise<string | null> {
  const stdout = await run(projectPath, ["remote", "-v"]);
  const usable = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    const name = match?.[1];
    const url = match?.[2];
    if (!name || !url || usable.has(name)) continue;
    const normalized = normalizeRemoteUrl(url);
    if (normalized !== null) usable.set(name, normalized);
  }
  for (const name of ["upstream", "origin"]) {
    const hit = usable.get(name);
    if (hit) return `remote:${hit}`;
  }
  const first = [...usable.keys()].toSorted()[0];
  return first ? `remote:${usable.get(first)}` : null;
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

// ASCII-only: JS toLowerCase applies Unicode mappings the Go port's
// strings.ToLower doesn't share exactly (U+0130 diverges), and hosts
// with such letters are already outside any registrable name. Lower
// only A-Z so both heads preserve everything else byte-for-byte.
function lowerAsciiHost(host: string): string {
  return host.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function joinHostPath(host: string, path: string): string | null {
  let repo = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (repo.endsWith(".git")) repo = repo.slice(0, -4).replace(/\/+$/, "");
  let folded = lowerAsciiHost(host);
  // `ssh.<host>` is the host's SSH-over-443 alias (github.com publishes
  // ssh.github.com, and GHE mirrors the shape): same repo, one key.
  // Mirrors normalizeHost in main/lib/githubCli/remote.ts.
  if (folded.startsWith("ssh.")) folded = folded.slice(4);
  if (folded.length === 0 || repo.length === 0) return null;
  return `${folded}/${repo}`;
}
