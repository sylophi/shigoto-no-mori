// The v3 migration as the host tells it (shellCalls' migration), which
// the windows read and follow (ipc/modules/migration.ts). The shell has
// it from the host's first moment, before the host's own listener
// serves anything, and keeps it until a window goes on to the app past
// it.
import { migrationContract } from "@shigomori/contracts/modules/migration";
import {
  type MigrationProgress,
  migrationShows,
} from "@shigomori/contracts/schemas/migration";
import * as Effect from "effect/Effect";
import { host, type HostFailure, restartParkedHost } from "../hostProcess";
import { broadcastAll } from "../ipc/register";
import { noteMigrating } from "./windows";

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

export const currentMigration = (): MigrationProgress | null => latest;

// A window went on to the app past the migration.
export function continueMigration(): void {
  continued = true;
  tell(null);
}

// A stuck import's host can't answer: it is started again instead.
export const retryMigration = (): Promise<void> =>
  latest?.import?.state === "stuck"
    ? restartParkedHost()
    : Effect.runPromise(host().migrationRetry());
