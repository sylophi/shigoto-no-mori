import { Data, Effect } from "effect";
import { Git, type GitService, runGitProgram } from "./core";

const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "dev"] as const;

class NoLocalBranches extends Data.TaggedError("NoLocalBranches")<{
  readonly projectPath: string;
}> {
  override get message(): string {
    return `No local branches found in ${this.projectPath}`;
  }
}

function runRemote<A>(
  effect: Effect.Effect<A, unknown, GitService>,
): Promise<A> {
  return runGitProgram(effect);
}

export async function localBranchExists(
  projectPath: string,
  branch: string,
): Promise<boolean> {
  return runRemote(
    Git.runVoid(projectPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
  );
}

export async function remoteRefExists(
  projectPath: string,
  ref: string,
): Promise<boolean> {
  return runRemote(
    Git.runVoid(projectPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/${ref}`,
    ]).pipe(
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
    ),
  );
}

export async function listRemotes(projectPath: string): Promise<string[]> {
  return runRemote(
    Effect.gen(function* () {
      const stdout = yield* Git.run(projectPath, ["remote"]);
      return stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }).pipe(Effect.catchAll(() => Effect.succeed<string[]>([]))),
  );
}

// Distinct URLs across all configured remotes. `git remote -v` emits two
// rows per remote (fetch + push) so we de-dupe; the host classification
// downstream doesn't care which side a URL came from.
export async function listRemoteUrls(projectPath: string): Promise<string[]> {
  return runRemote(
    Effect.gen(function* () {
      const stdout = yield* Git.run(projectPath, ["remote", "-v"]);
      const urls = new Set<string>();
      for (const line of stdout.split("\n")) {
        const match = line.match(/^\S+\s+(\S+)\s+\(/);
        if (match?.[1]) urls.add(match[1]);
      }
      return [...urls];
    }).pipe(Effect.catchAll(() => Effect.succeed<string[]>([]))),
  );
}

function firstLocalBranchEffect(projectPath: string) {
  return Effect.gen(function* () {
    const stdout = yield* Git.run(projectPath, [
      "for-each-ref",
      "--format=%(refname:short)",
      "--count=1",
      "refs/heads/",
    ]);
    const name = stdout.trim();
    return name.length > 0 ? name : null;
  }).pipe(Effect.catchAll(() => Effect.succeed<string | null>(null)));
}

function listRemotesEffect(projectPath: string) {
  return Effect.gen(function* () {
    const stdout = yield* Git.run(projectPath, ["remote"]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }).pipe(Effect.catchAll(() => Effect.succeed<string[]>([])));
}

function localBranchExistsEffect(projectPath: string, branch: string) {
  return Git.runVoid(projectPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

function remoteRefExistsEffect(projectPath: string, ref: string) {
  return Git.runVoid(projectPath, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/remotes/${ref}`,
  ]).pipe(
    Effect.as(true),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

export async function resolveDefaultBranch(
  projectPath: string,
  override?: string,
): Promise<string> {
  return runRemote(
    Effect.gen(function* () {
      const trimmed = override?.trim();
      if (trimmed) {
        // User explicitly picked it — accept whether it's local or remote.
        if (yield* localBranchExistsEffect(projectPath, trimmed))
          return trimmed;
        if (yield* remoteRefExistsEffect(projectPath, trimmed)) return trimmed;
      }
      // No (valid) override. Prefer a remote-tracking ref (the source of
      // truth) over the local copy, which tends to drift. Try each remote
      // in the order `git remote` lists them — usually that's the project's
      // canonical "origin"-equivalent first.
      const remotes = yield* listRemotesEffect(projectPath);
      for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
        for (const remote of remotes) {
          // oxlint-disable-next-line no-await-in-loop -- priority order matters
          if (
            yield* remoteRefExistsEffect(projectPath, `${remote}/${candidate}`)
          ) {
            return `${remote}/${candidate}`;
          }
        }
        // oxlint-disable-next-line no-await-in-loop -- priority order matters
        if (yield* localBranchExistsEffect(projectPath, candidate)) {
          return candidate;
        }
      }
      const first = yield* firstLocalBranchEffect(projectPath);
      if (first) return first;
      return yield* Effect.fail(new NoLocalBranches({ projectPath }));
    }),
  );
}

// Coalesces overlapping callers onto a single in-flight fetch so the
// focus-driven sweep and the periodic refresh can't dogpile a slow
// remote.
const fetchInflight = new Map<string, Promise<void>>();

export async function fetchAllRemotes(projectPath: string): Promise<void> {
  const existing = fetchInflight.get(projectPath);
  if (existing) return existing;
  const p = runRemote(
    Git.runVoid(projectPath, ["fetch", "--all", "--quiet", "--prune"]),
  )
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
export async function splitRemoteRef(
  projectPath: string,
  ref: string,
): Promise<{ remote: string; branch: string } | null> {
  const remotes = await listRemotes(projectPath);
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

// One branch from one remote -- cheaper than `fetch --all` when only
// that ref is needed.
export async function fetchRemoteRef(
  projectPath: string,
  remote: string,
  branch: string,
): Promise<void> {
  return runRemote(
    Git.runVoid(projectPath, ["fetch", "--quiet", remote, branch]),
  );
}

// Single-string snapshot of every remote-tracking ref + its SHA. Compared
// before/after a fetch to skip the broadcast when nothing actually moved.
export async function snapshotRemoteRefs(projectPath: string): Promise<string> {
  return runRemote(
    Git.run(projectPath, [
      "for-each-ref",
      "--format=%(objectname) %(refname)",
      "refs/remotes/",
    ]),
  );
}
