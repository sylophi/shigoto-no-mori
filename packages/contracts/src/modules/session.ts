import * as Schema from "effect/Schema";
import { defineContract, invoke } from "../contract.ts";
import { DeviceIdSchema, DeviceInfoSchema } from "../hubProtocol.ts";
import { GuideLaunchSchema } from "./guide.ts";
import { UpdaterStateSchema } from "../schemas/runtime.ts";
import { VoidSchema } from "../schemas/index.ts";
import { strict } from "../schemas/strict.ts";

// Loopback only, and kept out of allContractModules, so no window's api
// carries it.

// This device's place on the account, as the host's Colibrii device
// reports it: signed out (removed: the account let it go), enrolled,
// or stopped until a person acts.
export const DeviceAccountSchema = Schema.Union([
  Schema.TaggedStruct("SignedOut", { removed: Schema.Boolean }),
  Schema.TaggedStruct("Enrolled", {
    deviceId: Schema.String,
    accountId: Schema.String,
    connected: Schema.Boolean,
    // Until the hub socket has been up a while, a peer missing from the
    // roster may be one still reconnecting.
    settled: Schema.Boolean,
  }),
  Schema.TaggedStruct("Stopped", {
    deviceId: Schema.String,
    accountId: Schema.String,
    reason: Schema.Literals([
      "superseded",
      "credential-rejected",
      "update-required",
    ]),
  }),
]);
export type DeviceAccount = typeof DeviceAccountSchema.Type;

// What sm keeps on a device's record beside its name.
const DeviceDataSchema = strict(
  Schema.Struct({
    // os.platform(), or "web".
    platform: Schema.String,
    icon: Schema.String,
  }),
);
export type DeviceData = typeof DeviceDataSchema.Type;

const DeviceNameSchema = Schema.String.check(Schema.isBetweenLength(1, 256));

// What a change a person started is (or an auto-pull's fast-forward),
// for the words a quit asks with (app/shared/busy.ts).
const ChangeKindSchema = Schema.Literals([
  "commit",
  "push",
  "pull",
  "pullAndPush",
  "fetch",
  "merge",
  "checkout",
  "stash",
  "unstash",
  "finish",
  "pullRequest",
  "autoPull",
  "create",
  "land",
  "send",
  "bring",
  "remove",
  "move",
]);
export type ChangeKind = typeof ChangeKindSchema.Type;

const BusyOperationsSchema = strict(
  Schema.Struct({
    // PTY runs and the engine's lifecycle runs alike.
    runningScripts: Schema.Natural,
    // Worktree deletes, and project removals.
    inflightDeletes: Schema.Natural,
    // Worktree moves and renames, the data-folder move's included.
    inflightMoves: Schema.Natural,
    // The other git work a person started (or an auto-pull's), one
    // entry each.
    engineChanges: Schema.Array(ChangeKindSchema),
    // Terminals whose shell runs something.
    busyTerminals: Schema.Natural,
    // Queued moves waiting on another device or under way, which a
    // quit drops (sync:queued).
    queuedMoves: Schema.Natural,
  }),
);
export type BusyOperations = typeof BusyOperationsSchema.Type;

export const sessionContract = defineContract(
  "session",
  { scope: "host", remote: false },
  // The account the command switch the shell keeps is on for, null
  // when off: at start and as it flips.
  invoke("acceptsCommands", Schema.NullOr(Schema.String), VoidSchema),
  // This device's place on the account now.
  invoke("account", VoidSchema, DeviceAccountSchema),
  // The device's account calls. Their changes come back as
  // shellCalls:account.
  invoke(
    "enroll",
    strict(
      Schema.Struct({
        loginToken: Schema.String,
        name: DeviceNameSchema,
        data: DeviceDataSchema,
      }),
    ),
    VoidSchema,
  ),
  invoke("signOut", VoidSchema, VoidSchema),
  invoke("listDevices", VoidSchema, Schema.Array(DeviceInfoSchema)),
  invoke(
    "renameDevice",
    strict(Schema.Struct({ deviceId: DeviceIdSchema, name: DeviceNameSchema })),
    VoidSchema,
  ),
  invoke(
    "setDeviceData",
    strict(Schema.Struct({ deviceId: DeviceIdSchema, data: DeviceDataSchema })),
    VoidSchema,
  ),
  invoke("removeDevice", DeviceIdSchema, VoidSchema),
  invoke("windowFocused", Schema.Boolean, VoidSchema),
  // The hub socket and the peer links check in at once.
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
);
