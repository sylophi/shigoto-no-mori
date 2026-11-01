// The account as the root's callbacks read it (HostAccount, in the
// graph), synchronously: unknown until the graph is up and the shell's
// first report lands, which every reader takes as no account.
import type { HubAccount } from "@shared/account/hubConnect";
import type { DeviceInfo } from "@shigomori/contracts/hubProtocol";
import * as Effect from "effect/Effect";
import { type Account, HostAccount, UNREPORTED } from "@host/lib/HostAccount";
import * as Graph from "./graph";

const account = (): Account =>
  Graph.readNow(
    Effect.flatMap(HostAccount, (it) => it.current),
    () => UNREPORTED,
  );

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

// The account as the hub socket dials with it (shared/account/hubConnect.ts).
export function hubAccount(): HubAccount | null {
  const { facts, service } = account();
  return facts === null || service === null ? null : { ...facts, service };
}

// The account's device registry, for the terminal's cross-device verbs.
export async function listAccountDevices(
  signal: AbortSignal,
): Promise<DeviceInfo[]> {
  const { facts, service } = account();
  if (facts === null) return [];
  if (service === null) {
    throw new Error("signed out or the account service is not configured");
  }
  return service.listDevices(facts.credential, signal);
}
