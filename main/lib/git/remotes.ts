import {
  listRemotes as listRemotesWith,
  localBranchExists as localBranchExistsWith,
  remoteRefExists as remoteRefExistsWith,
  resolveDefaultBranch as resolveDefaultBranchWith,
  resolveDefaultRef as resolveDefaultRefWith,
} from "@shared/defaultBranch.mts";
import { run } from "./core";

// Default-branch policy lives in shared/defaultBranch.mts so the
// identity parity harness resolves through the same code. These
// wrappers bind the app's git runner.
export function localBranchExists(
  projectPath: string,
  branch: string,
): Promise<boolean> {
  return localBranchExistsWith(run, projectPath, branch);
}

export function remoteRefExists(
  projectPath: string,
  ref: string,
): Promise<boolean> {
  return remoteRefExistsWith(run, projectPath, ref);
}

export function listRemotes(projectPath: string): Promise<string[]> {
  return listRemotesWith(run, projectPath);
}

// Every row of `git remote -v` as a name + URL pair. git emits two rows
// per remote, fetch and push. Both are kept because a remote can push
// somewhere other than it fetches, and callers classifying hosts want to
// see either side. Identical rows are de-duped.
export async function listRemoteEntries(
  projectPath: string,
): Promise<{ name: string; url: string }[]> {
  try {
    const stdout = await run(projectPath, ["remote", "-v"]);
    const entries: { name: string; url: string }[] = [];
    const seen = new Set<string>();
    for (const line of stdout.split("\n")) {
      const match = line.match(/^(\S+)\s+(\S+)\s+\(/);
      const name = match?.[1];
      const url = match?.[2];
      if (!name || !url || seen.has(`${name}\t${url}`)) continue;
      seen.add(`${name}\t${url}`);
      entries.push({ name, url });
    }
    return entries;
  } catch {
    return [];
  }
}

export function resolveDefaultBranch(
  projectPath: string,
  override?: string,
): Promise<string> {
  return resolveDefaultBranchWith(run, projectPath, override);
}

// Qualified, fallback-free variant for repo identity. See
// shared/defaultBranch.mts for the contract split.
export function resolveDefaultRef(
  projectPath: string,
  override?: string,
): Promise<string | null> {
  return resolveDefaultRefWith(run, projectPath, override);
}

// Coalesces overlapping callers onto a single in-flight fetch so the
// focus-driven sweep and the periodic refresh can't dogpile a slow
// remote.
const fetchInflight = new Map<string, Promise<void>>();

export async function fetchAllRemotes(projectPath: string): Promise<void> {
  const existing = fetchInflight.get(projectPath);
  if (existing) return existing;
  const p = run(projectPath, ["fetch", "--all", "--quiet", "--prune"])
    .then(() => undefined)
    .finally(() => {
      fetchInflight.delete(projectPath);
    });
  fetchInflight.set(projectPath, p);
  return p;
}

// Splits a remote-tracking ref like "origin/main" or "fork/feat/x" into
// (remote, branch). Returns null if no configured remote matches.
// Picks the longest matching prefix so a remote named "origin/foo" wins
// over "origin" for "origin/foo/bar".
export function splitRemoteRefSync(
  ref: string,
  remotes: readonly string[],
): { remote: string; branch: string } | null {
  let best: { remote: string; branch: string } | null = null;
  for (const remote of remotes) {
    const prefix = `${remote}/`;
    if (!ref.startsWith(prefix)) continue;
    if (!best || remote.length > best.remote.length) {
      best = { remote, branch: ref.slice(prefix.length) };
    }
  }
  return best;
}

// Single-string snapshot of every remote-tracking ref + its SHA. Compared
// before/after a fetch to skip the broadcast when nothing actually moved.
export async function snapshotRemoteRefs(projectPath: string): Promise<string> {
  return run(projectPath, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/remotes/",
  ]);
}
