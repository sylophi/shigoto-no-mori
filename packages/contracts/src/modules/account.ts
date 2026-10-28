import * as Schema from "effect/Schema";
import { push, defineContract, invoke } from "../contract.ts";
import { DeviceIdSchema, DeviceInfoSchema } from "../hubProtocol.ts";
import { VoidSchema } from "../schemas/index.ts";
import { DeviceIconSchema } from "../deviceIcon.ts";
import { LoginCodeSchema } from "./login.ts";

// Client-scoped on purpose: enrollment writes an OS-keychain credential
// on the machine showing the window, so it must never reach a peer.

// accountId is empty when signed out. configured: the service env vars
// are set.
const AccountStatusSchema = Schema.Struct({
  configured: Schema.Boolean,
  signedIn: Schema.Boolean,
  accountId: Schema.String,
  deviceName: Schema.String,
  // The owner's pick, else what the device detected.
  deviceIcon: DeviceIconSchema,
  detectedDeviceIcon: DeviceIconSchema,
  // A dev profile's --clone-login copy: ending the Clerk session here
  // ends it there too.
  sharedSignIn: Schema.Boolean,
  // Signs in with a code approved on another device
  // (SHIGOMORI_CODE_SIGN_IN), for a window no one sits at.
  codeSignIn: Schema.Boolean,
  // Enrolled before device keys: reads as signed out until it enrolls
  // again.
  needsDeviceKey: Schema.Boolean,
});
export type AccountStatus = typeof AccountStatusSchema.Type;

export const accountContract = defineContract(
  "account",
  "client",
  // Every call is a file read and a keychain decrypt: ask on account
  // events, not on a poll.
  invoke("status", VoidSchema, AccountStatusSchema),
  // Takes a fresh Clerk session token.
  invoke("enroll", Schema.NonEmptyString, AccountStatusSchema),
  // The sign-in with a code (status.codeSignIn): Clerk's device grant,
  // approved from another device and traded with the hub for a Clerk
  // sign-in token, which the window redeems for its session.
  invoke("startCodeSignIn", VoidSchema, LoginCodeSchema),
  // Answers once the person approved. Refused when they denied it or
  // the code expired.
  invoke("finishCodeSignIn", LoginCodeSchema, Schema.String),
  // The revoke is best-effort, so sign-out succeeds offline.
  invoke("signOut", VoidSchema, VoidSchema),
  // Not best-effort, unlike signOut: nothing local stands in for "still
  // enrolled". Revoking this device clears its own credential too.
  invoke("revokeDevice", DeviceIdSchema, VoidSchema),
  // Empty when signed out or unconfigured.
  invoke("listDevices", VoidSchema, Schema.Array(DeviceInfoSchema)),
  // What listDevices last answered this shell for the account signed in
  // now, without asking the hub: a window loaded while the hub is away
  // lists its peers from it. Empty before the first answer.
  invoke("lastListedDevices", VoidSchema, Schema.Array(DeviceInfoSchema)),
  // Any device of the account, online or not: the hub holds the name.
  invoke(
    "setDeviceName",
    Schema.Struct({
      deviceId: DeviceIdSchema,
      // EnrollRequestSchema's bound, so a stored name never fails enroll.
      name: Schema.String.check(Schema.isBetweenLength(1, 256)),
    }),
    AccountStatusSchema,
  ),
  // Picking the detected icon puts it back to its default.
  invoke(
    "setDeviceIcon",
    Schema.Struct({ deviceId: DeviceIdSchema, icon: DeviceIconSchema }),
    AccountStatusSchema,
  ),
  // Whether this host serves its peers' gated calls, decided and
  // enforced on the machine being driven.
  invoke("acceptsCommands", VoidSchema, Schema.Boolean),
  // Throws if signed out: the switch is kept on the account's record.
  invoke("setAcceptsCommands", Schema.Boolean, VoidSchema),
  // Carries the account now signed in, so a listener can tell a rename
  // from a sign-out or a switch without a status read.
  push("changed", Schema.Struct({ accountId: Schema.NullOr(Schema.String) })),
  // Apart from `changed`, so the toggle doesn't thrash the status
  // queries. The one client-scoped push tagged remote: the switch is
  // this host's answer to its peers.
  push("commandAccessChanged", Schema.Boolean, {
    remote: true,
  }),
);
