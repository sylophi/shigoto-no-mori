import { gitContract } from "@shared/ipc/modules/git";
import type { Handlers } from "@shared/ipc/types";
import { maybeFetchProject } from "../../electron/fetch";
import { findProjectOrThrow } from "@host/lib/projects";

export const gitHandlers: Handlers<typeof gitContract> = {
  refreshProject: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    await maybeFetchProject(project.id, project.path);
  },
};
