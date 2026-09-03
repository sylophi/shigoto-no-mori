import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { DeviceIdSchema, DeviceInfoSchema } from "@shared/hub/protocol";

// The hub account layer as the renderer sees it. Client-scoped on
// purpose: enrollment writes an OS-keychain credential on the machine
// showing the window, so it must never be served to a remote peer.
// Being client-scoped also keeps every call structurally off the
// websocket wire (main/ipc/register.ts registers client channels only
// on the Electron binding), which is why these invokes carry no
// `remote` tag and the socket check exempts them.

// The renderer's whole view of account state in one object. accountId is
// empty when signed out. This device's id is not carried here since the
// renderer already has it synchronously as window.api.deviceId, so the
// "this device" marker reads that instead. configured is false until the
// owner sets the service env vars, and the UI shows a "not configured"
// state instead of a dead Sign in button.
export const AccountStatusSchema = z.object({
  configured: z.boolean(),
  signedIn: z.boolean(),
  accountId: z.string(),
  deviceName: z.string(),
});
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const accountContract = defineContract("client", {
  // Reads local state only: the resolved service config is cached, but
  // the stored credential metadata is a readFileSync plus an OS-keychain
  // decrypt on EVERY call, so invoke this on account events, not on a
  // poll. The device list is a separate call so a status read never
  // hits the device hub.
  status: invoke("account:status", z.void(), AccountStatusSchema),
  // Enrolls this device on the device hub under a fresh Clerk session
  // token (the renderer owns the Clerk sign-in UI and mints the token)
  // and stores the returned device credential. Resolves to the
  // post-enrollment status.
  enroll: invoke("account:enroll", z.string().min(1), AccountStatusSchema),
  // Best-effort revokes THIS device on the device hub, then clears the
  // stored credential locally. The revoke is best-effort so local
  // sign-out always succeeds even offline.
  signOut: invoke("account:signOut", z.void(), z.void()),
  // Removes a device from the ACCOUNT on the device hub, under this
  // device's credential: the target's credential stops working the
  // moment it next calls, and it disappears from every other device's
  // registry. Unlike signOut this is not best-effort -- a failed hub
  // call must surface, because nothing local stands in for "the device
  // is still enrolled". Bounded by DeviceIdSchema so a listed peer's id
  // always parses. The handler mirrors web/bridge/createWebBridge.ts's
  // revokeDevice, including the self-revoke caveat: revoking THIS
  // device invalidates our own credential, so the local one is cleared
  // in the same breath (the desktop UI offers Sign out for this device
  // instead, which ends the Clerk session first -- with the session
  // still live ClerkAccountSync would see "signed in, not enrolled" and
  // silently re-enroll, undoing the revoke).
  revokeDevice: invoke("account:revokeDevice", DeviceIdSchema, z.void()),
  // The account's device registry from the device hub, under the stored
  // credential. Element shape is the shared hub DeviceInfo so the app
  // and the Worker cannot drift. Empty when signed out or unconfigured.
  listDevices: invoke(
    "account:listDevices",
    z.void(),
    z.array(DeviceInfoSchema),
  ),
  // Renames this device locally (the stored metadata). A future slice may
  // push the rename to the device hub. Resolves to the updated status.
  setDeviceName: invoke(
    "account:setDeviceName",
    // Bounded to match EnrollRequestSchema.name so a stored name can
    // never later fail enroll's schema or blank the device identity.
    z.string().min(1).max(256),
    AccountStatusSchema,
  ),
  // Whether THIS host accepts commands from the account's other
  // devices: on, this machine serves their MUTATING calls over the
  // direct data plane instead of refusing them (reads were always
  // served). One switch for the whole account, made on the machine
  // being driven, and enforced host-local, so it never rides the hub
  // wire (client-scoped). False when signed out.
  acceptsCommands: invoke("account:acceptsCommands", z.void(), z.boolean()),
  // Flips the switch above. Idempotent. Throws if signed out, since
  // there is no account to scope the answer to.
  setAcceptsCommands: invoke(
    "account:setAcceptsCommands",
    z.boolean(),
    z.void(),
  ),
  // Fan-out after any sign-in, sign-out or rename so every window
  // re-reads status and the device list. Client-scoped, so it stays on
  // the Electron wire only.
  changed: broadcast("account:changed", z.void()),
  // Fan-out after the command-access switch flips, kept separate from
  // `changed` so the toggle does not thrash the account status and
  // device queries. The Devices page invalidates only the switch's
  // query on this.
  commandAccessChanged: broadcast("account:commandAccessChanged", z.void()),
});
