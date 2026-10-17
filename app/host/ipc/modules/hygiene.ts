import { UnknownWorktreeError } from "@shigomori/contracts/errors";
import { hygieneContract } from "@shigomori/contracts/modules/hygiene";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Hygiene from "@shigomori/engine/Hygiene";
import * as Effect from "effect/Effect";
import type { HostServices } from "@host/process/services";
import { findProject } from "@host/lib/projects";

const registered = Effect.fnUntraced(function* (projectId: string) {
  const { id, name, path } = yield* findProject(projectId);
  return { id, name, path };
});

export const hygieneHandlers = {
  list: ({ projectId }) =>
    Effect.gen(function* () {
      const hygiene = yield* Hygiene.Hygiene;
      return yield* hygiene.facts(yield* registered(projectId));
    }),

  diskUsage: ({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      const hygiene = yield* Hygiene.Hygiene;
      return yield* hygiene
        .diskUsage(yield* registered(projectId), worktreeId)
        .pipe(
          Effect.catchTag(
            "UnknownWorktree",
            () => new UnknownWorktreeError({ worktreeId }),
          ),
        );
    }),
} satisfies EffectHandlers<typeof hygieneContract, unknown, HostServices>;
