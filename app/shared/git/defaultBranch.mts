// The default-ref half of repo identity (shared/git/repoIdentity.mts),
// which peers compute for each other's repos: which branch keys the
// identity's root commit. Pure module, the runner is injected, so the
// parity harness (test/identity.mjs) runs it under its own scrubbed
// git. The CLI's resolver (pickDefaultRef in cli/gitx.go) makes the
// same pick for identity and for the primary ref it measures rows
// against, and test/identity.mjs pins the identities the two compute
// against each other.

// Runs git in `cwd`, resolves stdout, rejects on non-zero exit.
export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

// Spelled out for the user in RemoteWorktreeActions.tsx (NO_IDENTITY_NOTE),
// so a change here changes that sentence.
export const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "dev"] as const;

async function refExists(
  run: GitRunner,
  projectPath: string,
  fullRef: string,
): Promise<boolean> {
  try {
    await run(projectPath, ["show-ref", "--verify", "--quiet", fullRef]);
    return true;
  } catch {
    return false;
  }
}

export function localBranchExists(
  run: GitRunner,
  projectPath: string,
  branch: string,
): Promise<boolean> {
  return refExists(run, projectPath, `refs/heads/${branch}`);
}

export function remoteRefExists(
  run: GitRunner,
  projectPath: string,
  ref: string,
): Promise<boolean> {
  return refExists(run, projectPath, `refs/remotes/${ref}`);
}

export async function listRemotes(
  run: GitRunner,
  projectPath: string,
): Promise<string[]> {
  try {
    const stdout = await run(projectPath, ["remote"]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

// Candidate remotes in the SAME precedence remoteKey applies in
// shared/git/repoIdentity.mts: upstream first, then origin, then the rest
// alphabetically. `git remote` prints alphabetically, so without this a
// remote sorting before "origin" (say "base") would win the default-ref
// race, flip the root commit, and the two halves of identity would
// disagree about the canonical remote.
export function orderRemotesByPrecedence(remotes: readonly string[]): string[] {
  const preferred = ["upstream", "origin"].filter((name) =>
    remotes.includes(name),
  );
  const rest = remotes
    .filter((name) => name !== "upstream" && name !== "origin")
    .toSorted();
  return [...preferred, ...rest];
}

// The branch `refs/remotes/<remote>/HEAD` points at, fully qualified,
// or null when the remote has no HEAD symref or it dangles (a clone
// whose server-side default branch was later renamed or deleted keeps
// the stale symref). One spawn answers both: --verify makes rev-parse
// fail on a symref it cannot follow. A plain (non-symbolic) HEAD ref
// prints its own name and is no candidate either: an alias, not a
// branch, and the Go mirror's scan never holds it. Resolving the
// symref, rather than returning "origin/HEAD", keeps every caller
// looking at an ordinary remote-tracking ref.
async function remoteHeadTarget(
  run: GitRunner,
  projectPath: string,
  remote: string,
): Promise<string | null> {
  const head = `refs/remotes/${remote}/HEAD`;
  try {
    const target = (
      await run(projectPath, [
        "rev-parse",
        "--verify",
        "--symbolic-full-name",
        head,
      ])
    ).trim();
    return target.startsWith("refs/remotes/") && target !== head
      ? target
      : null;
  } catch {
    return null;
  }
}

// Fully qualified default ref (`refs/heads/<b>` or `refs/remotes/<r>/<b>`),
// or null when no override, candidate, remote-tracking candidate, or
// remote HEAD matches. Deliberately WITHOUT the first-local-branch
// fallback: repo identity resolves through this, and "whichever branch
// this device happens to have first" must never key an identity. The
// show-ref probes read a non-zero exit as "absent" (that IS git's
// not-found signal), so a broken git looks like "no default ref" here.
// Identity's remote rule runs its own git and surfaces the failure.
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
  // truth) over the local copy, which tends to drift. Try remotes in
  // identity's precedence order so both halves of identity key off the
  // same canonical remote.
  const remotes = orderRemotesByPrecedence(await listRemotes(run, projectPath));
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
  // Last, the remote's own HEAD: the symref `git clone` copies from the
  // server's default branch, so it names the same branch on every
  // clone. That is repo-derived, not device-derived like the
  // first-local-branch fallback this resolver refuses, so it can key an
  // identity for a repo whose trunk is called none of the candidates.
  // It runs after the candidate loop because this resolver also picks
  // merge targets: a repo with both origin/HEAD -> trunk and a stale
  // local main must keep merging into main, as it did before.
  for (const remote of remotes) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- priority order matters
    const target = await remoteHeadTarget(run, projectPath, remote); // oxlint-disable-line no-await-in-loop -- priority order matters
    if (target !== null) return target;
  }
  return null;
}
