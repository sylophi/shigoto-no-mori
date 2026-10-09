import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { VoidSchema } from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";
import { HostAddressSchema } from "./window.ts";

// What the host asks of the shell that started it (decision 6 of V3.md
// keeps the updater and the app's own lifetime in Electron's process),
// over the port the shell hands its utility process. Served by the
// shell alone, so kept out of allContractModules.

const UnattendedSchema = strict(Schema.Struct({ unattended: Schema.Boolean }));

export const shellCallsContract = defineContract(
  "shellCalls",
  "client",
  // The host is up: where its loopback listens, for the shell to dial
  // and to hand its windows.
  invoke("ready", HostAddressSchema, VoidSchema),
  // The host could not start: why, with what the engine's doctor found
  // when it was the store.
  invoke(
    "failed",
    strict(
      Schema.Struct({
        message: Schema.String,
        storeReport: Schema.NullOr(Schema.String),
      }),
    ),
    VoidSchema,
  ),
  // Restart the app with nobody at it to answer a prompt: after a
  // data-folder move a peer asked for.
  invoke("relaunch", VoidSchema, VoidSchema),
  invoke("updaterCheck", VoidSchema, VoidSchema),
  // `unattended` marks a call another device made: a busy host refuses
  // it instead of prompting a screen nobody watches.
  invoke("updaterInstall", UnattendedSchema, VoidSchema),
  invoke("updaterUpdate", UnattendedSchema, VoidSchema),
  // Stop the bridge `sm update` asks the updater through, before a wipe
  // of the data folder it lives in.
  invoke("stopUpdaterBridge", VoidSchema, VoidSchema),
);
