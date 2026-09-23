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
import { Duration, Effect } from "effect";
import { computeRepoIdentity } from "@shared/git/repoIdentity.mts";
import { getCached, makeTtlCache } from "../util/ttlCache";
import { promiseRunner, runGit, runUnder } from "./core";
import { resolveDefaultRefEffect } from "./remotes";

const identities = makeTtlCache(
  (projectPath: string) =>
    Effect.tryPromise({
      try: (signal): Promise<string | null> =>
        computeRepoIdentity(projectPath, {
          run: promiseRunner(signal),
          resolveDefaultRef: (path) =>
            runUnder(resolveDefaultRefEffect(path), signal),
        }),
      catch: (error) => error,
    }).pipe(Effect.withSpan("repoIdentity.getRepoIdentity")),
  Duration.seconds(60),
);

export function getRepoIdentityEffect(
  projectPath: string,
): Effect.Effect<string | null, unknown> {
  return getCached(identities, projectPath);
}

export function getRepoIdentity(projectPath: string): Promise<string | null> {
  return runGit(getRepoIdentityEffect(projectPath));
}
