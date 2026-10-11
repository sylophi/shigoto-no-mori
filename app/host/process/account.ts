// The account as the root's callbacks read it (HostAccount, in the
// graph), synchronously: signed out until the graph is up and the
// shell's first report lands.
import type { AccountFacts } from "@shigomori/contracts/modules/session";
import type {
  DeviceInfo,
  TunnelProvisionResponse,
} from "@shigomori/contracts/hubProtocol";
import * as Effect from "effect/Effect";
import { type Account, HostAccount } from "@host/lib/HostAccount";
import * as Graph from "./graph";

export type { AccountFacts };

const account = (): Account =>
  Graph.readNow(
    Effect.flatMap(HostAccount, (it) => it.current),
    () => ({ facts: null, service: null }),
  );

// Replaces the facts, answering the ones they replaced.
export const setAccountFacts = (
  next: AccountFacts | null,
): Promise<AccountFacts | null> =>
  Graph.run(Effect.flatMap(HostAccount, (it) => it.set(next)));

export function accountSignedIn(): boolean {
  return account().facts !== null;
}

// The predicate the device link's gate consults live on every gated
// call, and the verdict every connectInfo answer reports. Every peer
// that reaches the listener is a device of this account (its connect
// ticket bound it to one), so the answer is the account-wide switch.
export function acceptsPeerCommands(): boolean {
  return account().facts?.acceptsCommands === true;
}

export function allowedWebOrigin(): string | undefined {
  const { facts } = account();
  return facts === null || facts.webOrigin === "" ? undefined : facts.webOrigin;
}

function signedIn(): {
  facts: AccountFacts;
  service: NonNullable<Account["service"]>;
} {
  const { facts, service } = account();
  if (facts === null || service === null) {
    throw new Error("signed out or the account service is not configured");
  }
  return { facts, service };
}

// What the hub socket needs. mintTicket reads the credential on every
// call, so one the shell rotated meanwhile is the one used.
export function hubConnectInputs(): {
  hubUrl: string;
  accountId: string;
  deviceKey: string;
  mintTicket: (connectionId: string, signal: AbortSignal) => Promise<string>;
} | null {
  const { facts } = account();
  if (facts === null) return null;
  return {
    hubUrl: facts.hubUrl,
    // A different account forces the hub socket onto the new account's
    // object instead of leaving the old socket live.
    accountId: facts.accountId,
    deviceKey: facts.deviceKey,
    mintTicket: async (connectionId, signal) => {
      const current = signedIn();
      return (
        await current.service.mintTicket(
          current.facts.credential,
          connectionId,
          signal,
        )
      ).ticket;
    },
  };
}

// Points this device's named tunnel at the listener's current port.
// The connector token it answers is a bearer secret the caller keeps in
// memory only. Bounded, so a black-holed route cannot wedge the
// tunnel's serialized lifecycle.
export function provisionDeviceTunnel(
  port: number,
): Promise<TunnelProvisionResponse> {
  const current = signedIn();
  return current.service.provisionTunnel(
    current.facts.credential,
    port,
    AbortSignal.timeout(15_000),
  );
}

// The account's device registry, for the terminal's cross-device verbs.
export async function listAccountDevices(): Promise<DeviceInfo[]> {
  if (account().facts === null) return [];
  const current = signedIn();
  return current.service.listDevices(current.facts.credential);
}
