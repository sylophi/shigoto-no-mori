import type { migrationContract } from "@shigomori/contracts/modules/migration";
import type { Handlers } from "@shigomori/contracts/types";
import type { HandlerContext } from "@shared/ipc/transport";
import {
  continueMigration,
  currentMigration,
  retryMigration,
} from "../../electron/migration";

export const migrationHandlers: Handlers<
  typeof migrationContract,
  HandlerContext
> = {
  read: currentMigration,
  continue: continueMigration,
  retry: retryMigration,
};
