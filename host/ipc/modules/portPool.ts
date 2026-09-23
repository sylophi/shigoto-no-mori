import { Effect } from "effect";
import { portPoolContract } from "@shared/ipc/modules/portPool";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import {
  isPortPoolActive,
  isPortPoolEnabled,
  isPortPoolInstalled,
} from "@host/lib/portPool";
import { findProjectAndWorktree } from "@host/lib/projects";
import { hostAttempt, hostHandler } from "@host/runtime";

export const portPoolHandlers: Handlers<
  typeof portPoolContract,
  HandlerContext
> = {
  isActive: hostHandler(({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      // The toggle first, before anything forks git: off is the
      // default, and a stale worktree id must answer false, not throw.
      if (!(yield* hostAttempt(() => isPortPoolEnabled()))) return false;
      const { worktree } = yield* findProjectAndWorktree(projectId, worktreeId);
      return yield* hostAttempt(() => isPortPoolActive(worktree.path));
    }),
  ),

  isInstalled: hostHandler(() => hostAttempt(() => isPortPoolInstalled())),
};
