import { z } from "zod";
import { broadcast, defineContract, invoke } from "@shared/ipc/contract";
import { DeviceIdSchema, DeviceInfoSchema } from "@shared/relay/protocol";

// The relay account layer as the renderer sees it. Client-scoped on
// purpose: sign-in drives an OS browser and writes an OS-keychain
// credential on the machine showing the window, so it must never be
// served to a remote peer. Being client-scoped also keeps every call
// structurally off the websocket wire (main/ipc/register.ts registers
// client channels only on the Electron binding), which is why these
// invokes carry no `remote` tag and the socket check exempts them.

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
  // hits the relay.
  status: invoke("account:status", z.void(), AccountStatusSchema),
  // Runs the full OAuth + enroll flow. Opens the user's browser, awaits
  // the loopback redirect, exchanges the code, enrolls this device and
  // stores the credential. Resolves to the post-sign-in status.
  signIn: invoke("account:signIn", z.void(), AccountStatusSchema),
  // Best-effort revokes THIS device on the relay, then clears the stored
  // credential locally. The revoke is best-effort so local sign-out
  // always succeeds even offline. Removing OTHER devices from the list is
  // a later slice.
  signOut: invoke("account:signOut", z.void(), z.void()),
  // The account's device registry from the relay, under the stored
  // credential. Element shape is the shared relay DeviceInfo so the app
  // and the Worker cannot drift. Empty when signed out or unconfigured.
  listDevices: invoke(
    "account:listDevices",
    z.void(),
    z.array(DeviceInfoSchema),
  ),
  // Renames this device locally (the stored metadata). A future slice may
  // push the rename to the relay. Resolves to the updated status.
  setDeviceName: invoke(
    "account:setDeviceName",
    // Bounded to match EnrollRequestSchema.name so a stored name can
    // never later fail enroll's schema or blank the device identity.
    z.string().min(1).max(256),
    AccountStatusSchema,
  ),
  // Grants a peer device command access on THIS host: after the grant,
  // this machine serves that peer's MUTATING relay calls instead of
  // refusing them (reads were always served). Scoped to the current
  // account and enforced host-local, so it never rides the relay wire
  // (client-scoped). Throws if signed out. The deviceId bound matches
  // DeviceInfo.deviceId so a listed peer's id always parses.
  grantCommands: invoke("account:grantCommands", DeviceIdSchema, z.void()),
  // Withdraws a peer device's command access, so its mutating calls are
  // refused again. Reads remain served. Idempotent.
  revokeCommands: invoke("account:revokeCommands", DeviceIdSchema, z.void()),
  // The peer deviceIds this host currently trusts to run commands, for
  // the CURRENT account. Empty when signed out or none granted.
  listGrantedDevices: invoke(
    "account:listGrantedDevices",
    z.void(),
    z.array(z.string()),
  ),
  // Fan-out after any sign-in, sign-out or rename so every window
  // re-reads status and the device list. Client-scoped, so it stays on
  // the Electron wire only.
  changed: broadcast("account:changed", z.void()),
  // Fan-out after a command grant or revoke, kept separate from `changed`
  // so a grant toggle does not thrash the account status and device
  // queries. The account settings invalidates only the granted-set query
  // on this.
  grantsChanged: broadcast("account:grantsChanged", z.void()),
});
