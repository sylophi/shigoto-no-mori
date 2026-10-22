// The account as the host knows it: the facts its shell hands over at
// start and after every change (main/electron/account.ts keeps the
// credential in the keychain and the Clerk session; the host never
// opens either), with the hub's account service for them. Null is
// signed out, or a build with no account service, which the hub
// socket, the device link's listener and the tunnel all read as "stop".
// Until the shell's first report the account is unknown, not signed
// out: a host started again under a running shell may still be on one.
import type { AccountFacts } from "@shigomori/contracts/modules/session";
import {
  type AccountService,
  createAccountService,
} from "@shared/account/service";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export type Account = {
  readonly reported: boolean;
  readonly facts: AccountFacts | null;
  readonly service: AccountService | null;
};

export const UNREPORTED: Account = {
  reported: false,
  facts: null,
  service: null,
};

export class HostAccount extends Context.Service<
  HostAccount,
  {
    readonly current: Effect.Effect<Account>;
    // Replaces the facts, answering the account they replaced.
    readonly set: (next: AccountFacts | null) => Effect.Effect<Account>;
  }
>()("sm/host/HostAccount") {}

export const layer = Layer.effect(
  HostAccount,
  Effect.map(Ref.make<Account>(UNREPORTED), (account) =>
    HostAccount.of({
      current: Ref.get(account),
      set: Effect.fn("HostAccount.set")((next: AccountFacts | null) =>
        Ref.modify(account, (previous) => [
          previous,
          {
            reported: true,
            facts: next,
            service:
              next === null
                ? null
                : previous.facts?.hubUrl === next.hubUrl &&
                    previous.service !== null
                  ? previous.service
                  : createAccountService({ baseUrl: next.hubUrl }),
          },
        ]),
      ),
    }),
  ),
);
