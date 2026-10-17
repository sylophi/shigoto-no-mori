import * as Schema from "effect/Schema";
import { defineContract, invoke, Remote } from "../contract.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { GuideLaunchSchema } from "./guide.ts";
import { UpdaterStateSchema } from "../schemas/runtime.ts";
import { VoidSchema } from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// Loopback only, and kept out of allContractModules, so no window's api
// carries it.

// The shell keeps the credential and device key in the keychain and
// hands them over after every change: the host holds them in memory
// only.
const AccountFactsSchema = strict(
  Schema.Struct({
    hubUrl: Schema.String,
    accountId: Schema.String,
    credential: Schema.String,
    // Base64url: what the relay and link handshakes prove this device by.
    deviceKey: Schema.String,
    // The one extra origin the device link's listener admits.
    webOrigin: Schema.String,
    acceptsCommands: Schema.Boolean,
  }),
);
export type AccountFacts = typeof AccountFactsSchema.Type;

const BusyOperationsSchema = strict(
  Schema.Struct({
    runningScripts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    inflightDeletes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    engineChanges: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    busyTerminals: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

export const sessionContract = defineContract(
  "session",
  "host",
  // Null when signed out or unconfigured. At start and after every change.
  invoke("account", Schema.NullOr(AccountFactsSchema), VoidSchema),
  invoke("accountDevices", Schema.Array(DeviceIdSchema), VoidSchema),
  invoke("windowFocused", Schema.Boolean, VoidSchema),
  // Every remote socket is probed.
  invoke("wake", VoidSchema, VoidSchema),
  invoke("busy", VoidSchema, BusyOperationsSchema),
  invoke("updaterState", UpdaterStateSchema, VoidSchema),
  invoke("guideLaunch", GuideLaunchSchema, VoidSchema),
  // Its progress comes as the move's did.
  invoke("migrationRetry", VoidSchema, VoidSchema),
  // A hurried quit (an update install, a relaunch) signals scripts
  // instead of waiting.
  invoke(
    "quit",
    strict(Schema.Struct({ hurried: Schema.Boolean })),
    VoidSchema,
  ),
).annotateRpcs(Remote, false);
