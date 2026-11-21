// The account as the root's callbacks read it (HostAccount, in the
// graph), synchronously: unknown until the graph is up and the device's
// first report lands, which every reader takes as no account.
import * as Effect from "effect/Effect";
import { type Account, HostAccount, UNREPORTED } from "@host/lib/HostAccount";
import * as Graph from "./graph";

const account = (): Account =>
  Graph.readNow(
    Effect.flatMap(HostAccount, (it) => it.current),
    () => UNREPORTED,
  );

// The predicate a peer's gate consults live on every gated call, and the
// verdict every welcome reports. Every peer is a device of this
// account, so the answer is the account-wide switch.
export function acceptsPeerCommands(): boolean {
  return account().facts?.acceptsCommands === true;
}
