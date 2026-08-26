// Default-branch resolution, extracted from host/lib/git/remotes.ts so
// the parity harness (scripts/check-identity.mjs) can run the same
// policy under its own scrubbed git runner instead of a hand-written
// mirror. Pure module: the runner is injected. Mirrored by
// resolveDefaultBranchWithRemotes in cli/gitx.go. Keep the precedence
// in sync.

// Runs git in `cwd`, resolves stdout, rejects on non-zero exit.
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "dev"] as const;

export async function localBranchExists(
  run: GitRunner,
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
  run: GitRunner,
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

export async function listRemotes(
  run: GitRunner,
  projectPath: string,
): Promise<string[]> {
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

async function firstLocalBranch(
  run: GitRunner,
  projectPath: string,
): Promise<string | null> {
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

// Fully qualified default ref (`refs/heads/<b>` or `refs/remotes/<r>/<b>`),
// or null when no override, candidate, or remote-tracking candidate
// matches. Deliberately WITHOUT the first-local-branch fallback: repo
// identity resolves through this, and "whichever branch this device
// happens to have first" must never key an identity. The show-ref
// probes read a non-zero exit as "absent" (that IS git's not-found
// signal), so a broken git looks like "no default ref" here. Identity's
// remote rule runs its own git and surfaces the failure.
export async function resolveDefaultRef(
  run: GitRunner,
  projectPath: string,
  override?: string,
): Promise<string | null> {
  const trimmed = override?.trim();
  if (trimmed) {
    // User explicitly picked it, so accept whether it's local or remote.
    if (await localBranchExists(run, projectPath, trimmed)) {
      return `refs/heads/${trimmed}`;
    }
    if (await remoteRefExists(run, projectPath, trimmed)) {
      return `refs/remotes/${trimmed}`;
    }
  }
  // No (valid) override. Prefer a remote-tracking ref (the source of
  // truth) over the local copy, which tends to drift. Try each remote
  // in the order `git remote` lists them (usually that's the project's
  // canonical "origin"-equivalent first).
  const remotes = await listRemotes(run, projectPath);
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    for (const remote of remotes) {
      const ref = `${remote}/${candidate}`;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- priority order matters
      const exists = await remoteRefExists(run, projectPath, ref); // oxlint-disable-line no-await-in-loop -- priority order matters
      if (exists) return `refs/remotes/${ref}`;
    }
    // oxlint-disable-next-line no-await-in-loop -- priority order matters
    if (await localBranchExists(run, projectPath, candidate)) {
      return `refs/heads/${candidate}`;
    }
  }
  return null;
}

// resolveDefaultRef only ever yields these two namespaces, so a
// two-branch strip recovers exactly the short names the pre-qualified
// resolver returned ("main", "origin/main").
function shortRefName(fullRef: string): string {
  return fullRef.startsWith("refs/heads/")
    ? fullRef.slice("refs/heads/".length)
    : fullRef.slice("refs/remotes/".length);
}

// Short-name variant for merge-target callers, who additionally accept
// an arbitrary first local branch as a last resort (a merge target only
// has to exist, while an identity must be stable across devices, hence
// the split from resolveDefaultRef).
export async function resolveDefaultBranch(
  run: GitRunner,
  projectPath: string,
  override?: string,
): Promise<string> {
  const full = await resolveDefaultRef(run, projectPath, override);
  if (full !== null) return shortRefName(full);
  const first = await firstLocalBranch(run, projectPath);
  if (first) return first;
  throw new Error(`No local branches found in ${projectPath}`);
}
