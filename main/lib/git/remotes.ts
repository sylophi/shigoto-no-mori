import { run } from "./core";

const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "dev"] as const;

export async function localBranchExists(
  projectPath: string,
  branch: string,
): Promise<boolean> {
  try {
    await run(projectPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function remoteRefExists(
  projectPath: string,
  ref: string,
): Promise<boolean> {
  try {
    await run(projectPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/${ref}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function listRemotes(projectPath: string): Promise<string[]> {
  try {
    const stdout = await run(projectPath, ["remote"]);
    const remotes: string[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) remotes.push(trimmed);
    }
    return remotes;
  } catch {
    return [];
  }
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

async function firstLocalBranch(projectPath: string): Promise<string | null> {
  try {
    const stdout = await run(projectPath, [
      "for-each-ref",
      "--format=%(refname:short)",
      "--count=1",
      "refs/heads/",
    ]);
    const name = stdout.trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export async function resolveDefaultBranch(
  projectPath: string,
  override?: string,
): Promise<string> {
  const trimmed = override?.trim();
  if (trimmed) {
    // User explicitly picked it — accept whether it's local or remote.
    if (await localBranchExists(projectPath, trimmed)) return trimmed;
    if (await remoteRefExists(projectPath, trimmed)) return trimmed;
  }
  // No (valid) override. Prefer a remote-tracking ref (the source of
  // truth) over the local copy, which tends to drift. Try each remote
  // in the order `git remote` lists them — usually that's the project's
  // canonical "origin"-equivalent first.
  const remotes = await listRemotes(projectPath);
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    for (const remote of remotes) {
      const ref = `${remote}/${candidate}`;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- priority order matters
      const exists = await remoteRefExists(projectPath, ref); // oxlint-disable-line no-await-in-loop -- priority order matters
      if (exists) return ref;
    }
    // oxlint-disable-next-line no-await-in-loop -- priority order matters
    if (await localBranchExists(projectPath, candidate)) return candidate;
  }
  const first = await firstLocalBranch(projectPath);
  if (first) return first;
  throw new Error(`No local branches found in ${projectPath}`);
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
