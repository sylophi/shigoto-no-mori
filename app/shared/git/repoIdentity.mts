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

import { normalizeRemoteUrl } from "@shigomori/contracts/predicates/remoteUrl";
import { type GitRunner, orderRemotesByPrecedence } from "./defaultBranch.mts";

interface RepoIdentityDeps {
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
// beats `origin` beats the alphabetically-first remote (the one
// precedence, orderRemotesByPrecedence in defaultBranch.mts), considering
// only remotes whose URL normalizes (path-style and file:// remotes are
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
  const first = orderRemotesByPrecedence([...usable.keys()])[0];
  return first ? `remote:${usable.get(first)}` : null;
}
