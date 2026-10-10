import * as Schema from "effect/Schema";
import { broadcast, defineContract, invoke } from "../contract.ts";
import { DeviceIdSchema, DeviceInfoSchema } from "../hubProtocol.ts";
import { VoidSchema } from "../schemas/index.ts";
import { DeviceIconSchema } from "../deviceIcon.ts";

// The hub account layer as the renderer sees it. Client-scoped on
// purpose: enrollment writes an OS-keychain credential on the machine
// showing the window, so it must never be served to a remote peer.
// Being client-scoped also keeps every call structurally off the
// websocket wire (main/ipc/register.ts registers client channels only
// on the Electron binding), which is why these invokes carry no
// `remote` tag and the registrar does not ask them to.

// The renderer's whole view of account state in one object. accountId is
// empty when signed out. This device's id is not carried here since the
// renderer already has it synchronously as window.api.deviceId, so the
// "this device" marker reads that instead. configured is false until the
// owner sets the service env vars, and the UI shows a "not configured"
// state instead of a dead Sign in button.
export const AccountStatusSchema = Schema.Struct({
  configured: Schema.Boolean,
  signedIn: Schema.Boolean,
  accountId: Schema.String,
  deviceName: Schema.String,
  // What this device looks like, as every surface draws it: the
  // owner's pick where there is one, else what the device detected.
  deviceIcon: DeviceIconSchema,
  // What it detected about itself, so the picker can mark that entry
  // and picking it reads as "back to the default".
  detectedDeviceIcon: DeviceIconSchema,
  // The sign-in behind this device is a copy another window holds too
  // (a dev profile launched with --clone-login), so ending the Clerk
  // session here ends it there as well. Always false outside dev.
  sharedSignIn: Schema.Boolean,
  // The device enrolled before device keys and must enroll again to
  // make one (a step of the move to v3): it reads as signed out until
  // it has. The renderer drives it with useDeviceKeyStep.
  needsDeviceKey: Schema.Boolean,
});
export type AccountStatus = typeof AccountStatusSchema.Type;

export const accountContract = defineContract(
  "account",
  "client",
  // Reads local state only: the resolved service config is cached, but
  // the stored credential metadata is a readFileSync plus an OS-keychain
  // decrypt on EVERY call, so invoke this on account events, not on a
  // poll. The device list is a separate call so a status read never
  // hits the device hub.
  invoke("status", VoidSchema, AccountStatusSchema),
  // Enrolls this device on the device hub under a fresh Clerk session
  // token (the renderer owns the Clerk sign-in UI and mints the token)
  // and stores the returned device credential. Resolves to the
  // post-enrollment status.
  invoke("enroll", Schema.NonEmptyString, AccountStatusSchema),
  // Best-effort revokes THIS device on the device hub, then clears the
  // stored credential locally. The revoke is best-effort so local
  // sign-out always succeeds even offline.
  invoke("signOut", VoidSchema, VoidSchema),
  // Removes a device from the ACCOUNT on the device hub, under this
  // device's credential: the target's credential stops working the
  // moment it next calls, and it disappears from every other device's
  // registry. Unlike signOut this is not best-effort -- a failed hub
  // call must surface, because nothing local stands in for "the device
  // is still enrolled". Bounded by DeviceIdSchema so a listed peer's id
  // always parses. The handler mirrors web/ipc/register.ts's
  // revokeDevice, including the self-revoke caveat: revoking THIS
  // device invalidates our own credential, so the local one is cleared
  // in the same breath (the desktop UI offers Sign out for this device
  // instead, which ends the Clerk session too, rather than leaving one
  // live with no device under it).
  invoke("revokeDevice", DeviceIdSchema, VoidSchema),
  // The account's device registry from the device hub, under the stored
  // credential. Element shape is the shared hub DeviceInfo so the app
  // and the Worker cannot drift. Empty when signed out or unconfigured.
  invoke("listDevices", VoidSchema, Schema.Array(DeviceInfoSchema)),
  // Renames any device of the account, this one or a peer, online or
  // not: the device hub's registry holds the name (shared/account/
  // enroll.ts updateDevice). Throws when the hub did not take it.
  // Resolves to the updated status.
  invoke(
    "setDeviceName",
    Schema.Struct({
      deviceId: DeviceIdSchema,
      // Bounded to match EnrollRequestSchema.name so a stored name can
      // never later fail enroll's schema or blank the device identity.
      name: Schema.String.check(Schema.isBetweenLength(1, 256)),
    }),
    AccountStatusSchema,
  ),
  // Picks the icon of any device of the account (drawn for it
  // everywhere), the rename's twin. Picking a device's detected icon
  // puts it back to its default. Resolves to the updated status.
  invoke(
    "setDeviceIcon",
    Schema.Struct({ deviceId: DeviceIdSchema, icon: DeviceIconSchema }),
    AccountStatusSchema,
  ),
  // Whether THIS host accepts commands from the account's other
  // devices: on, its direct listener serves their gated calls (every
  // channel not registered gated:false) instead of refusing them.
  // One switch for the whole account, made on the machine being
  // driven and enforced there alone, by the listener's dispatch gate.
  // False when signed out.
  invoke("acceptsCommands", VoidSchema, Schema.Boolean),
  // Flips the switch above. Idempotent. Throws if signed out, since
  // the switch is kept on the signed-in account's record.
  invoke("setAcceptsCommands", Schema.Boolean, VoidSchema),
  // Fan-out after any sign-in, sign-out or rename so every window
  // re-reads status and the device list. Client-scoped, so it stays on
  // the windows' shell ports. Carries the account now signed in (null
  // when signed out) so a listener can tell a rename from a sign-out
  // or an account switch without a status read of its own.
  broadcast(
    "changed",
    Schema.Struct({ accountId: Schema.NullOr(Schema.String) }),
  ),
  // Fan-out after the command-access switch flips (or the account
  // under it changes), carrying the switch. Kept separate from
  // `changed` so the toggle does not thrash the account status and
  // device queries: the account page refreshes only the switch's query
  // on this. The one client-scoped broadcast tagged remote, because the
  // switch is this host's answer to its peers: the direct listener
  // pushes it to every connected peer too, whose bridge records it as
  // HubStatus.peerAcceptsCommands (shared/hub/directPlane.ts).
  broadcast("commandAccessChanged", Schema.Boolean, {
    remote: true,
  }),
);
