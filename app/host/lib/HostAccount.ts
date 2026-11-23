// The account as the host knows it: the one its Colibrii device is
// enrolled under (PeerDevice.ts), with the command switch the shell
// keeps for it. Null is signed out, or a build with no account service.
// Until the device's first report the account is unknown, not signed
// out: a host started again may still be on one.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export type AccountFacts = {
  readonly accountId: string;
  readonly acceptsCommands: boolean;
};

export type Account = {
  readonly reported: boolean;
  readonly facts: AccountFacts | null;
};

export const UNREPORTED: Account = { reported: false, facts: null };

export class HostAccount extends Context.Service<
  HostAccount,
  {
    readonly current: Effect.Effect<Account>;
    // The account, then each time it is set.
    readonly changes: Stream.Stream<Account>;
    // Replaces the facts, answering the account they replaced.
    readonly set: (next: AccountFacts | null) => Effect.Effect<Account>;
  }
>()("sm/host/HostAccount") {}

export const layer = Layer.effect(
  HostAccount,
  Effect.map(SubscriptionRef.make<Account>(UNREPORTED), (account) =>
    HostAccount.of({
      current: SubscriptionRef.get(account),
      changes: SubscriptionRef.changes(account),
      set: Effect.fn("HostAccount.set")((next: AccountFacts | null) =>
        SubscriptionRef.modify(account, (previous) => [
          previous,
          { reported: true, facts: next },
        ]),
      ),
    }),
  ),
);
