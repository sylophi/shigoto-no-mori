import * as Schema from "effect/Schema";
import { defineContract, invoke, Remote } from "../contract.ts";
import { DeviceIdSchema } from "../hubProtocol.ts";
import { UpdaterStateSchema } from "../schemas/runtime.ts";
import { VoidSchema } from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// The shell's session with the host it started (decision 6 of V3.md):
// what the Electron process tells its host and asks of it, beside the
// calls every window makes. Served on the loopback only (contracts'
// link.ts, LoopbackGroup), so no call is remote, and kept out of
// allContractModules, so no window's api carries it.

// The account as the host is to know it. The shell keeps the credential
// in the keychain and hands it over after every change: a bearer
// secret the host holds in memory only.
const AccountFactsSchema = strict(
  Schema.Struct({
    hubUrl: Schema.String,
    accountId: Schema.String,
    credential: Schema.String,
    // The web client's origin, the one extra origin the device link's
    // listener admits. Empty when none is configured.
    webOrigin: Schema.String,
    // The command-access switch, kept on the account's record.
    acceptsCommands: Schema.Boolean,
  }),
);
export type AccountFacts = typeof AccountFactsSchema.Type;

// What a quit, a restart into an update or a data-folder move would
// interrupt.
const BusyOperationsSchema = strict(
  Schema.Struct({
    runningScripts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    inflightDeletes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    // Terminals whose shell runs something (a quit and a restart ask
    // about them, a data-folder move does not count them).
    busyTerminals: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
);

export const sessionContract = defineContract(
  "session",
  "host",
  // The account's facts, null when signed out or unconfigured: at
  // start, and after every change.
  invoke("account", Schema.NullOr(AccountFactsSchema), VoidSchema),
  // The account's registry, as the shell last read it from the hub.
  invoke("accountDevices", Schema.Array(DeviceIdSchema), VoidSchema),
  // A window of this machine gained or lost focus.
  invoke("windowFocused", Schema.Boolean, VoidSchema),
  // The machine woke: every remote socket is probed.
  invoke("wake", VoidSchema, VoidSchema),
  invoke("busy", VoidSchema, BusyOperationsSchema),
  // The shell's updater moved.
  invoke("updaterState", UpdaterStateSchema, VoidSchema),
  // Stop: the host closes its graph and exits. A hurried quit (an
  // update install, a relaunch) signals scripts instead of waiting.
  invoke(
    "quit",
    strict(Schema.Struct({ hurried: Schema.Boolean })),
    VoidSchema,
  ),
).annotateRpcs(Remote, false);
