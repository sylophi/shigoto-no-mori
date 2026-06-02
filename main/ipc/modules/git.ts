import { gitContract } from "@shared/ipc/modules/git";
import type { Handlers } from "@shared/ipc/types";
import { maybeFetchProject } from "../../electron/fetch";
import { findProjectOrThrow } from "../../lib/projects";
import type { HandlerContext } from "../register";

export const gitHandlers: Handlers<typeof gitContract, HandlerContext> = {
  refreshProject: async ({ projectId }) => {
    const project = findProjectOrThrow(projectId);
    await maybeFetchProject(project.id, project.path);
  },
};
