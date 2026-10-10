import { portsContract } from "@shigomori/contracts/modules/ports";
import type { Handlers, ViewHandlers } from "@shigomori/contracts/types";
import * as Effect from "effect/Effect";
import * as Views from "@host/lib/views";
import { scriptsContract } from "@shigomori/contracts/modules/scripts";
import * as Ports from "@host/lib/ports";

const listPorts = (worktree: {
  readonly projectId: string;
  readonly worktreeId: string;
}) =>
  Effect.flatMap(Ports.Ports, (ports) => ports.list(worktree)).pipe(
    Effect.map((ports) => ({ ports })),
  );

export const portsHandlers = {
  list: listPorts,
} satisfies Handlers<typeof portsContract, unknown, Ports.Ports>;

export const portsViews: ViewHandlers<
  typeof portsContract,
  Views.Services | Ports.Ports
> = {
  // A server coming up on a port says nothing to the host, so the
  // probes run again every few seconds.
  watch: (worktree) =>
    Views.view(
      `ports:watch:${worktree.projectId}:${worktree.worktreeId}`,
      () => listPorts(worktree),
      Views.either(
        Views.wrote("worktree_data"),
        Views.pushed(scriptsContract, "changed"),
      ),
      { every: "5 seconds" },
    ),
};
