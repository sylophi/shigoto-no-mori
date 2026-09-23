// Binds the shared repo-identity algorithm to the real git runner and
// default-ref resolver. Identity is derived state and is NEVER
// persisted. The cache only spares repeated git spawns, so negative
// results (null identity) are cached like any other. A git failure
// fails instead of answering null, and a failure is never cached (its
// time to live is zero), so a transient failure can't stick as "no
// identity". Concurrent callers join one in-flight compute, which is
// interrupted (its git killed) once every caller waiting on it has
// gone. A root commit and a remote URL essentially never change, so
// the TTL is the whole staleness rule.
import { Cache, Duration, Effect, Exit } from "effect";
import { computeRepoIdentity } from "@shared/git/repoIdentity.mts";
import { promiseRunner, runGit, runUnder } from "./core";
import { resolveDefaultRefEffect } from "./remotes";

const IDENTITY_TTL = Duration.seconds(60);

const identities = Effect.runSync(
  Cache.makeWith<string, string | null, unknown>(
    (projectPath) =>
      Effect.tryPromise({
        try: (signal) =>
          computeRepoIdentity(projectPath, {
            run: promiseRunner(signal),
            resolveDefaultRef: (path) =>
              runUnder(resolveDefaultRefEffect(path), signal),
          }),
        catch: (error) => error,
      }).pipe(Effect.withSpan("repoIdentity.getRepoIdentity")),
    {
      // Repositories are few; a safety bound, not a budget.
      capacity: 10_000,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? IDENTITY_TTL : Duration.zero,
    },
  ),
);

export function getRepoIdentityEffect(
  projectPath: string,
): Effect.Effect<string | null, unknown> {
  return Cache.get(identities, projectPath);
}

export function getRepoIdentity(projectPath: string): Promise<string | null> {
  return runGit(getRepoIdentityEffect(projectPath));
}
