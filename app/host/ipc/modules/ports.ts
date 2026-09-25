// A worktree's ports (shared/ipc/modules/ports.ts): port-pool's
// allocation for the directory when the integration is on, then the
// user-added entries from the worktree data file, each probed on this
// machine's loopback.
import { portsContract } from "@shared/ipc/modules/ports";
import type { Handlers } from "@shared/ipc/types";
import { mergeWorktreePorts } from "@shared/ports/mergeWorktreePorts";
import { readWorktreeData } from "@host/lib/config/project";
import { findWorktreeIdentityOrThrow } from "@host/lib/git/worktrees";
import { isLoopbackPortListening } from "@host/lib/net";
import { isPortPoolActive, poolPortsFor } from "@host/lib/portPool";
import { findProjectOrThrow } from "@host/lib/projects";
import { ttlMapCache } from "@host/lib/util/ttlCache";

// A loopback dial answers in microseconds when something listens and
// is refused just as fast when nothing does. The deadline only matters
// for a wedged listener, and a short one keeps the list snappy.
const PROBE_TIMEOUT_MS = 400;

// The renderer polls this read for liveness, and resolving an id to
// its path forks `git worktree list` each time. A worktree's path is
// fixed for its id (the id IS a hash of the path, relocation mints a
// new one), so the lookup is safe to hold for a while: a deleted
// worktree's page is gone before the entry matters.
const PATH_CACHE_TTL_MS = 60_000;
const pathCache = ttlMapCache<string, string>(
  PATH_CACHE_TTL_MS,
  async (key) => {
    const [projectId, worktreeId] = key.split(":") as [string, string];
    const project = findProjectOrThrow(projectId);
    const worktree = await findWorktreeIdentityOrThrow(
      project.id,
      project.path,
      worktreeId,
    );
    return worktree.path;
  },
);

export const portsHandlers: Handlers<typeof portsContract> = {
  list: async ({ projectId, worktreeId }) => {
    // Validated first so a bogus project id never builds a path.
    findProjectOrThrow(projectId);
    // The pool chain hangs off the path alone, so it runs beside the
    // data-file read rather than behind it.
    const [pool, data] = await Promise.all([
      pathCache
        .get(`${projectId}:${worktreeId}`)
        .then(async (path) =>
          (await isPortPoolActive(path)) ? poolPortsFor(path) : [],
        ),
      readWorktreeData(projectId, worktreeId),
    ]);
    const ports = await Promise.all(
      // The merge mints fresh objects, so each is completed in place.
      mergeWorktreePorts(pool, data?.ports ?? []).map(async (entry) =>
        Object.assign(entry, {
          listening: await isLoopbackPortListening(
            entry.port,
            PROBE_TIMEOUT_MS,
          ),
        }),
      ),
    );
    return { ports };
  },
};
