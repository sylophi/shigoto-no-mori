import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke } from "../contract.ts";
import { MigrationSchema, VoidSchema } from "../schemas/index.ts";

// The v3 migration of this device, as it goes, for the page a window
// shows in place of the app while it runs. The shell serves it, from
// what its host tells it (shellCalls' migration): the move into wt/
// runs before the host's services start, which its loopback waits on,
// and the shell's port to each window is up from the first moment.
// Null until the host has said.
export const migrationContract = defineContract(
  "migration",
  "client",
  invoke("read", VoidSchema, Schema.NullOr(MigrationSchema)),
  broadcast("changed", MigrationSchema),
);
