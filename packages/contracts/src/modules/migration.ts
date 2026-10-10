import { defineContract, view } from "../contract.ts";
import { MigrationSchema, VoidSchema } from "../schemas/index.ts";

// The v3 migration of this device, as it goes, for the screen a window
// shows in place of the app while it runs. This device's own: no peer
// reads it.
export const migrationContract = defineContract(
  "migration",
  "host",
  view("watch", VoidSchema, MigrationSchema, { remote: false, gated: false }),
);
