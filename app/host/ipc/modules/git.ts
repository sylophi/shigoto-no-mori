import { gitContract } from "@shigomori/contracts/modules/git";
import type { Handlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import type * as Engine from "@host/lib/engine";
import { findProject } from "@host/lib/projects";
import { fromPromise } from "@host/lib/util/fromPromise";
import { implSlot } from "@host/lib/util/implSlot";

// The electron layer injects the background-fetch entry point at boot.
// The fetch scheduler itself stays in main/electron because it
// broadcasts through the Electron transport binding.
type GitImpl = {
  refreshProject: (projectId: string, projectPath: string) => Promise<void>;
  sweepForPeer: () => { leaseMs: number };
};

const { set: setGitImpl, get: gitImpl } = implSlot<GitImpl>(
  "git handler invoked before setGitImpl registered one",
);
export { setGitImpl };

export const gitHandlers = {
  refreshProject: ({ projectId }) =>
    Effect.flatMap(findProject(projectId), (project) =>
      fromPromise(() => gitImpl().refreshProject(project.id, project.path)),
    ),
  sweep: () => gitImpl().sweepForPeer(),
} satisfies Handlers<typeof gitContract, unknown, Engine.Services>;
