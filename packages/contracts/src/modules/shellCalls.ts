import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { HexId32Schema } from "../schemas/hexId.ts";
import { MigrationSchema, VoidSchema } from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";
import { GuideDrivePayloadSchema, GuideReplySchema } from "./guide.ts";
import { HostAddressSchema } from "./window.ts";

// Served by the shell alone, so kept out of allContractModules.

// A host that could not start, and its store when that was what failed:
// the doctor's report, and whether a newer version of the app made it.
export const HostFailureSchema = strict(
  Schema.Struct({
    message: Schema.String,
    store: Schema.NullOr(
      strict(Schema.Struct({ report: Schema.String, newer: Schema.Boolean })),
    ),
  }),
);

const UnattendedSchema = strict(Schema.Struct({ unattended: Schema.Boolean }));

export const shellCallsContract = defineContract(
  "shellCalls",
  "client",
  // The token opens the shell's own session calls.
  invoke(
    "ready",
    strict(
      Schema.Struct({
        ...HostAddressSchema.struct.fields,
        shellToken: HexId32Schema,
      }),
    ),
    VoidSchema,
  ),
  invoke("failed", HostFailureSchema, VoidSchema),
  invoke("migration", MigrationSchema, VoidSchema),
  // With nobody at it: after a move a peer asked for.
  invoke("relaunch", VoidSchema, VoidSchema),
  // The app doesn't run on without its watchers.
  invoke(
    "moveFailed",
    strict(Schema.Struct({ reason: Schema.String })),
    VoidSchema,
  ),
  invoke("updaterCheck", VoidSchema, VoidSchema),
  // `unattended`: another device asked, so a busy host refuses instead of
  // prompting a screen nobody watches.
  invoke("updaterInstall", UnattendedSchema, VoidSchema),
  invoke("updaterUpdate", UnattendedSchema, VoidSchema),
  // Before a move or a reset of the data folder it works in: the updater
  // starts nothing there from now on (null), or the version an install
  // under way restarts into ("" when it is not known).
  invoke(
    "holdUpdater",
    strict(Schema.Struct({ for: Schema.Literals(["move", "reset"]) })),
    Schema.NullOr(Schema.String),
  ),
  // A move that failed before the folder moved, the app carrying on.
  invoke("resumeUpdater", VoidSchema, VoidSchema),
  // Before the folder moves: the bridge `sm update` asks through stopped.
  invoke("stopUpdaterBridge", VoidSchema, VoidSchema),
  invoke("guide", GuideDrivePayloadSchema, GuideReplySchema),
  // The account page's switches the shell keeps, which a terminal sets
  // too (control:setAccess).
  invoke("setAcceptsCommands", Schema.Boolean, VoidSchema),
  invoke("keepReachable", VoidSchema, Schema.Boolean),
  invoke("setKeepReachable", Schema.Boolean, VoidSchema),
);
