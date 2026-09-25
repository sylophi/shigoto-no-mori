import { gitContract } from "@shared/ipc/modules/git";
import type { Handlers } from "@shared/ipc/types";
import { findProjectOrThrow } from "@host/lib/projects";
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

export const gitHandlers: Handlers<typeof gitContract> = {
  refreshProject: async ({ projectId }) => {
    const project = await findProjectOrThrow(projectId);
    await gitImpl().refreshProject(project.id, project.path);
  },
  sweep: async () => gitImpl().sweepForPeer(),
};
