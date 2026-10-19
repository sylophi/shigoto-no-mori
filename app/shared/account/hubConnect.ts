// What the hub socket dials with, both shells' (host/process/wires.ts,
// web/ipc/register.ts), off the account as `signedIn` reads it now: null
// signed out. The ticket mint reads it again on every call, so a
// credential rotated meanwhile is the one used.
import type { HubConnectOpts } from "@shared/hub/connectionTypes";
import type { AccountService } from "./service";

export type HubAccount = {
  readonly hubUrl: string;
  readonly accountId: string;
  readonly deviceKey: string;
  readonly credential: string;
  readonly service: AccountService;
};

export function hubConnectInputs(
  signedIn: () => HubAccount | null,
  deviceId: string,
): HubConnectOpts | null {
  const now = signedIn();
  if (now === null) return null;
  return {
    hubUrl: now.hubUrl,
    // A different account forces the hub socket onto the new account's
    // object instead of leaving the old socket live.
    accountId: now.accountId,
    deviceId,
    deviceKey: now.deviceKey,
    mintTicket: async (connectionId, signal) => {
      const fresh = signedIn();
      if (fresh === null) throw new Error("signed out, no hub credential");
      return (
        await fresh.service.mintTicket(fresh.credential, connectionId, signal)
      ).ticket;
    },
  };
}
