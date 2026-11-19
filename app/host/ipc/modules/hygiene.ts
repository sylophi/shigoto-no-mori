import { hygieneContract } from "@shigomori/contracts/modules/hygiene";
import type { EffectHandlers } from "@shigomori/contracts/types";
import * as Hygiene from "@shigomori/engine/Hygiene";
import * as Effect from "effect/Effect";
import type { HostServices } from "@host/process/services";
import { findProject } from "@host/lib/projects";

export const hygieneHandlers = {
  list: ({ projectId }) =>
    Effect.gen(function* () {
      const hygiene = yield* Hygiene.Hygiene;
      return yield* hygiene.facts(yield* findProject(projectId));
    }),

  diskUsage: ({ projectId, worktreeId }) =>
    Effect.gen(function* () {
      const hygiene = yield* Hygiene.Hygiene;
      return yield* hygiene.diskUsage(
        yield* findProject(projectId),
        worktreeId,
      );
    }),
} satisfies EffectHandlers<typeof hygieneContract, unknown, HostServices>;
