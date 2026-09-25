import { gitContract } from "@shared/ipc/modules/git";
import type { Handlers } from "@shared/ipc/types";
import { findProjectOrThrow } from "@host/lib/projects";

// The electron layer injects the background-fetch entry point at boot.
// The fetch scheduler itself stays in main/electron because it
// broadcasts through the Electron transport binding.
type GitImpl = {
  refreshProject: (projectId: string, projectPath: string) => Promise<void>;
  sweepForPeer: () => { leaseMs: number };
};

let impl: GitImpl | null = null;

export function setGitImpl(next: GitImpl): void {
  impl = next;
}

function gitImpl(): GitImpl {
  if (impl === null) {
    throw new Error("git handler invoked before setGitImpl registered one");
  }
  return impl;
}

export const gitHandlers: Handlers<typeof gitContract> = {
  refreshProject: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    await gitImpl().refreshProject(project.id, project.path);
  },
  sweep: async () => gitImpl().sweepForPeer(),
};
