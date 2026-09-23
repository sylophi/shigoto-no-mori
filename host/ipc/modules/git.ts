import { Context, Effect } from "effect";
import { gitContract } from "@shared/ipc/modules/git";
import type { HandlerContext } from "@shared/ipc/transport";
import type { Handlers } from "@shared/ipc/types";
import { findProjectOrThrow } from "@host/lib/projects";
import { hostAttempt, hostHandler, requireService } from "@host/runtime";

// The electron layer provides the background-fetch entry points. The
// fetch scheduler itself stays in main/electron because it broadcasts
// through the Electron transport binding.
type GitImpl = {
  refreshProject: (projectId: string, projectPath: string) => Promise<void>;
  sweepForPeer: () => { leaseMs: number };
};

export class BackgroundFetch extends Context.Service<
  BackgroundFetch,
  GitImpl
>()("sm/host/BackgroundFetch") {}

const backgroundFetch = requireService(
  BackgroundFetch,
  "git handler invoked before the host runtime provided BackgroundFetch",
);

export const gitHandlers: Handlers<typeof gitContract, HandlerContext> = {
  refreshProject: hostHandler(({ projectId }: { projectId: string }) =>
    Effect.gen(function* () {
      const fetch = yield* backgroundFetch;
      yield* hostAttempt(() => {
        const project = findProjectOrThrow(projectId);
        return fetch.refreshProject(project.id, project.path);
      });
      return undefined;
    }),
  ),
  sweep: hostHandler(() =>
    Effect.flatMap(backgroundFetch, (fetch) =>
      hostAttempt(() => fetch.sweepForPeer()),
    ),
  ),
};
