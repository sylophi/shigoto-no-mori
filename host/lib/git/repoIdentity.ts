// Binds the shared repo-identity algorithm to the real git runner and
// default-ref resolver. Identity is derived state and is NEVER
// persisted. The cache only spares repeated git spawns, so negative
// results (null identity) are cached like any other. A git failure
// rejects instead of resolving null, and ttlMapCache never caches
// rejections, so a transient failure can't stick as "no identity".
// Concurrent callers share one in-flight compute via the cache's own
// coalescing. A root commit and a remote URL essentially never change,
// so the TTL is the whole staleness rule.
import { computeRepoIdentity } from "@shared/repoIdentity.mts";
import { ttlMapCache } from "../util/ttlCache";
import { run } from "./core";
import { resolveDefaultRef } from "./remotes";

const cache = ttlMapCache<string, string | null>(60_000, (projectPath) =>
  computeRepoIdentity(projectPath, {
    run,
    resolveDefaultRef: (path) => resolveDefaultRef(path),
  }),
);

export function getRepoIdentity(projectPath: string): Promise<string | null> {
  return cache.get(projectPath);
}
