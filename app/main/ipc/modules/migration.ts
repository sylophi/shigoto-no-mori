// The v3 migration as the host tells it (shellCalls' migration), served
// to the windows over their shell link. The shell has it from the
// host's first moment, before the host's own listener serves anything,
// and keeps it until a window goes on to the app past it.
import { migrationContract } from "@shigomori/contracts/modules/migration";
import {
  type MigrationProgress,
  migrationShows,
} from "@shigomori/contracts/schemas/migration";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import { noteMigrating } from "../../electron/windows";
import * as Effect from "effect/Effect";
import { host, type HostFailure, restartParkedHost } from "../../hostProcess";
import { broadcastAll } from "../register";

let latest: MigrationProgress | null = null;
let continued = false;

const tell = (progress: MigrationProgress | null) => {
  latest = progress;
  noteMigrating(progress !== null && migrationShows(progress));
  broadcastAll(migrationContract, "changed", progress);
};

// A host starting over says nothing yet, which never replaces what the
// one before it said.
export function noteMigration(progress: MigrationProgress): void {
  if (continued || (!progress.planned && latest?.planned === true)) return;
  tell(progress);
}

// A host that couldn't start while the page shows the import: the page
// says why, in place of the dialog, and its Retry starts a host again.
// False when no import is under way here.
export function migrationFailed(failure: HostFailure): boolean {
  if (continued || latest?.import == null || latest.import.state === "done") {
    return false;
  }
  tell({
    ...latest,
    import: {
      state: "stuck",
      reason: failure.store?.report ?? failure.message,
    },
  });
  return true;
}

export const migrationHandlers: Handlers<
  typeof migrationContract,
  HandlerContext
> = {
  read: () => latest,
  continue: () => {
    continued = true;
    tell(null);
  },
  // A stuck import's host can't answer: it is started again instead.
  retry: () =>
    latest?.import?.state === "stuck"
      ? restartParkedHost()
      : Effect.runPromise(host().migrationRetry()),
};
