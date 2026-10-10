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
import { broadcastAll } from "../register";

let latest: MigrationProgress | null = null;
let continued = false;

const tell = (progress: MigrationProgress | null) => {
  latest = progress;
  noteMigrating(progress !== null && migrationShows(progress));
  broadcastAll(migrationContract, "changed", progress);
};

export function noteMigration(progress: MigrationProgress): void {
  if (!continued) tell(progress);
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
};
