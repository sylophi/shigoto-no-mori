// The tab's local registrar: what a browser serves itself, in the page.
// A web client is a device with no host: every
// host it shows is a peer, reached over the device link through the
// hub (shared/hub/directPlane.ts). What stays in the page are the
// client modules (the account, the client config, the hub bridge, the
// shell, the releases) and the browser's own copy of the shared
// settings, registered (shared/ipc/served.ts) like every binding's, and
// called through the runtime's Api like every window's.
//
// A host call nothing here serves is the renderer asking a local host
// the browser does not have, which it still does in a few places. Those
// are answered FAIL-CLOSED: a read (`gated: false`) or a channel on
// STUB_ALLOWED below gets the empty answer its output schema allows
// (stubDefaults.ts), so a shared component renders an empty state, and
// everything else is refused: a mutation, an unclassified channel, a
// read with no empty answer, and a view. So a future channel is refused
// until someone classifies it as a read, and no mutation or permission-
// shaped query can report success on the web. A channel absent from the
// contract entirely is a wiring bug, and dies.
import {
  annotation,
  callsOf,
  channelOf,
  type ContractCall,
  type ContractModule,
  type ContractScope,
  Gated,
  inputOf,
  isInvoke,
  isPush,
  outputOf,
  scopeOf,
} from "@shigomori/contracts/contract";
import { decode } from "@shigomori/contracts/codec";
import { callFailureOf, RemoteCallError } from "@shigomori/contracts/errors";
import { allContractModules } from "@shigomori/contracts/allModules";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HandlerContext, Link } from "@shared/ipc/transport";
import { pushFanOut } from "@shared/remote/rpcTransport";
import { createServed, resolvePush, type Served } from "@shared/ipc/served";
import type { PushKeys, PushProducerPayload } from "@shigomori/contracts/types";
import { NO_STRUCTURAL_STUB, stubValueFor } from "./stubDefaults";

// The hand-judged exceptions to the gated:false rule, each saying why a
// stub is harmless:
//
//   - window:previewTheme: fired by ThemeProvider on every applied
//     theme change to sync the native window chrome. There is no
//     native chrome in a browser, so a void resolve is the truthful
//     answer, and rejecting would surface an unhandled rejection on
//     every theme flip.
const STUB_ALLOWED = new Set(["window:previewTheme"]);

// A host call the tab cannot answer, the browser having no host: one it
// may not pretend to serve, or a read with no empty answer to give. A
// call failing in the far side's own words (the page is that side), so
// a window reading it as a view does not ask again every few seconds.
const refusal = (channel: string, reason: "unavailable" | "noSafeAnswer") =>
  new RemoteCallError({
    text:
      reason === "unavailable"
        ? `${channel} is not available in the browser`
        : `${channel} has no safe empty answer in the browser`,
  });

export type LocalRegistrar = {
  served: Served<HandlerContext, never, unknown>;
  link: Link;
  // A push to the page, as a host's reaches its windows.
  push: <M extends ContractModule, K extends PushKeys<M>>(
    module: M,
    key: K,
    payload: PushProducerPayload<M, K>,
  ) => void;
};

// Every invoke (of one scope, when given), keyed by channel, for the
// stub fallback. Built from the same module list the runtime's Api is
// built from (renderer/lib/runtime/Api.ts), so the inventory cannot
// drift from the api surface. Exported for the
// fake host's fixture wire (lab/fake-host/bridge.ts), which stubs the
// same way and answers a view's fixture as it does an invoke's (`views`).
export function invokeIndexFor(
  scope?: ContractScope,
  views = false,
): Map<string, ContractCall> {
  const index = new Map<string, ContractCall>();
  for (const module of allContractModules) {
    if (scope !== undefined && scopeOf(module) !== scope) continue;
    for (const call of callsOf(module)) {
      if (isInvoke(call) || (views && !isPush(call))) {
        index.set(channelOf(call), call);
      }
    }
  }
  return index;
}

export function createLocalRegistrar(options: {
  // Each answer checked against its output schema, as a dev build does:
  // the page has no RPC server to encode it.
  readonly validateOutputs: boolean;
}): LocalRegistrar {
  // What a handler rejects with (a contract error, any Error) is the
  // call's failure as it is, and a synchronous throw is too.
  const served = createServed<HandlerContext, never, unknown>({
    failure: (error) => error,
  });
  const fanOut = pushFanOut();
  const invokeIndex = invokeIndexFor();
  // Views among the calls, which viewOf picks out.
  const callIndex = invokeIndexFor(undefined, true);
  // Fallback verdicts are computed once per channel: the policy is
  // deterministic and some stub outputs are sizeable object shapes. A
  // verdict is either a resolvable stub value or the refusal.
  type FallbackVerdict = { stub: unknown } | { refusal: RemoteCallError };
  const verdictCache = new Map<string, FallbackVerdict>();

  function fallbackVerdict(
    channel: string,
    call: ContractCall,
  ): FallbackVerdict {
    const allowlisted = STUB_ALLOWED.has(channel);
    if (annotation(call, Gated) !== false && !allowlisted) {
      // Mutations, and local channels that never classified themselves
      // as reads, must not pretend to succeed.
      return { refusal: refusal(channel, "unavailable") };
    }
    const stub = stubValueFor(outputOf(call), { fabricateArms: false });
    if (stub === NO_STRUCTURAL_STUB) {
      // A read whose output demands a fabricated arm (an enum, a union,
      // a bounded scalar) gets no invented answer either.
      return { refusal: refusal(channel, "noSafeAnswer") };
    }
    return { stub };
  }

  // One handler context for the page's lifetime. In-page the caller IS
  // the peer, so its connection never ends.
  const pageLifetime = new AbortController();
  const context: HandlerContext = {
    notifier: (module, key) => (payload) => {
      const push = resolvePush(module, key, payload);
      fanOut.emit(push.channel, push.payload);
    },
    connection: pageLifetime.signal,
  };

  const link: Link = {
    local: true,
    call(channel, input) {
      const call = invokeIndex.get(channel);
      if (call === undefined) {
        return Effect.die(
          new Error(`no handler and no contract entry for channel ${channel}`),
        );
      }
      // In the page, so nothing on a wire decodes the input: it is
      // decoded here as a server's group would.
      const handler = served.invokeOf(call);
      if (handler !== undefined) {
        return Effect.flatMap(
          Effect.try({
            try: () => decode(inputOf(call), input),
            catch: callFailureOf,
          }),
          (decoded) =>
            options.validateOutputs
              ? Effect.tap(handler(decoded, context), (answer) =>
                  Effect.try({
                    try: () => Schema.encodeUnknownSync(outputOf(call))(answer),
                    catch: callFailureOf,
                  }),
                )
              : handler(decoded, context),
        );
      }
      let verdict = verdictCache.get(channel);
      if (verdict === undefined) {
        verdict = fallbackVerdict(channel, call);
        verdictCache.set(channel, verdict);
      }
      return "refusal" in verdict
        ? Effect.fail(verdict.refusal)
        : Effect.succeed(verdict.stub);
    },
    pushes: fanOut.pushes,
    view(channel, input) {
      const call = callIndex.get(channel);
      const view = call === undefined ? undefined : served.viewOf(call);
      if (call === undefined || view === undefined) {
        return Stream.fail(refusal(channel, "unavailable"));
      }
      // Decoded here as a server's group would, like an invoke's input.
      return Stream.unwrap(
        Effect.map(
          Effect.try({
            try: () => decode(inputOf(call), input),
            catch: callFailureOf,
          }),
          view,
        ),
      );
    },
  };

  return {
    served,
    link,
    push: (module, key, payload) => {
      const push = resolvePush(module, key, payload);
      fanOut.emit(push.channel, push.payload);
    },
  };
}
