// The account as the host knows it: the facts its shell hands over at
// start and after every change (main/ipc/modules/account.ts keeps the
// credential in the keychain and the Clerk session; the host never
// opens either). Null is signed out, or a build with no account
// service, which the hub socket, the device link's listener and the
// tunnel all read as "stop".
import type { AccountFacts } from "@shigomori/contracts/modules/session";
import {
  type AccountService,
  createAccountService,
} from "@shared/account/service";
import type {
  DeviceInfo,
  TunnelProvisionResponse,
} from "@shigomori/contracts/hubProtocol";

export type { AccountFacts };

let facts: AccountFacts | null = null;
let service: AccountService | null = null;

// Replaces the facts, returning the ones they replaced.
export function setAccountFacts(
  next: AccountFacts | null,
): AccountFacts | null {
  const previous = facts;
  facts = next;
  if (next === null) service = null;
  else if (previous?.hubUrl !== next.hubUrl) {
    service = createAccountService({ baseUrl: next.hubUrl });
  }
  return previous;
}

export function accountSignedIn(): boolean {
  return facts !== null;
}

// The predicate the device link's gate consults live on every gated
// call, and the verdict every connectInfo answer reports. Every peer
// that reaches the listener is a device of this account (its connect
// ticket bound it to one), so the answer is the account-wide switch.
export function acceptsPeerCommands(): boolean {
  return facts?.acceptsCommands === true;
}

export function allowedWebOrigin(): string | undefined {
  return facts === null || facts.webOrigin === "" ? undefined : facts.webOrigin;
}

function signedIn(): { facts: AccountFacts; service: AccountService } {
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
  mintTicket: (connectionId: string, signal: AbortSignal) => Promise<string>;
} | null {
  if (facts === null) return null;
  return {
    hubUrl: facts.hubUrl,
    // A different account forces the hub socket onto the new account's
    // object instead of leaving the old socket live.
    accountId: facts.accountId,
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
  if (facts === null) return [];
  const current = signedIn();
  return current.service.listDevices(current.facts.credential);
}
