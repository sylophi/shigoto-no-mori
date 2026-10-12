// The tab's local registrar: what a browser serves itself, in the page.
// A web client is a device with no host: every
// host it shows is a peer, reached over the device link through the
// hub (shared/hub/directPlane.ts). What stays in the page are the
// client modules (the account, the client config, the hub bridge, the
// shell, the releases) and the browser's own copy of the shared
// settings, registered (shared/ipc/served.ts) like every binding's, and
// called through buildApi like every window's.
//
// A host call nothing here serves is the renderer asking a local host
// the browser does not have, which it still does in a few places. Those
// are answered FAIL-CLOSED:
//
//   - An invoke explicitly classified `gated: false` (the registrar
//     makes every remote-exposed host invoke classify itself, and only
//     reads carry false) may resolve to a schema-derived
//     structural stub (stubDefaults.ts), so a shared read-only
//     component renders an empty state instead of throwing.
//   - A channel on the small STUB_ALLOWED list below may stub too, with
//     fabricated enum/union arms permitted, because each entry has been
//     judged harmless by hand.
//   - EVERYTHING else rejects with a clear "not available in the
//     browser" error: mutations (`gated: true`), unclassified
//     local-only channels, and any read whose output cannot be met
//     without fabricating an affirmative value. A future contract
//     channel therefore rejects by default until someone classifies it
//     as a read or allowlists it, so no mutation or permission-shaped
//     query can ever silently report success on the web.
//
// A channel absent from the contract entirely also rejects, because
// answering it would hide a real wiring bug.
import {
  annotation,
  callOf,
  callsOf,
  channelOf,
  type ContractCall,
  type ContractModule,
  type ContractScope,
  Gated,
  inputOf,
  isInvoke,
  outputOf,
  scopeOf,
} from "@shigomori/contracts/contract";
import { decode } from "@shigomori/contracts/codec";
import { callFailureOf } from "@shigomori/contracts/errors";
import { allContractModules } from "@shigomori/contracts/allModules";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { HandlerContext, Link } from "@shared/ipc/transport";
import { pushFanOut } from "@shared/remote/rpcTransport";
import { createServed, resolvePush, type Served } from "@shared/ipc/served";
import type {
  PushKeys,
  PushProducerPayload,
  ViewObserver,
} from "@shigomori/contracts/types";
import { NO_STRUCTURAL_STUB, stubValueFor } from "./stubDefaults";

// The hand-judged exceptions to the gated:false rule. Every entry
// must state why answering it with a stub is harmless. Keep this list
// short on purpose: anything not here and not classified as a read
// rejects.
//
//   - window:previewTheme: fired by ThemeProvider on every applied
//     theme change to sync the native window chrome. There is no
//     native chrome in a browser, so a void resolve is the truthful
//     answer, and rejecting would surface an unhandled rejection on
//     every theme flip.
const STUB_ALLOWED = new Set(["window:previewTheme"]);

// A host call the tab cannot answer, the browser having no host: one it
// may not pretend to serve, or a read with no empty answer to give.
class BrowserRefusal extends Schema.TaggedError<BrowserRefusal>()(
  "BrowserRefusal",
  {
    channel: Schema.String,
    reason: Schema.Literals(["unavailable", "noSafeAnswer"]),
  },
) {
  override get message(): string {
    return this.reason === "unavailable"
      ? `${this.channel} is not available in the browser`
      : `${this.channel} has no safe empty answer in the browser`;
  }
}

// A view the page serves itself (hub:watchPeer), observed until the
// returned stop.
type LocalView = (
  input: unknown,
  observer: ViewObserver<unknown>,
) => () => void;

export type LocalRegistrar = {
  served: Served<HandlerContext>;
  link: Link;
  view: (module: ContractModule, key: string, view: LocalView) => void;
  // A push to the page, as a host's reaches its windows.
  push: <M extends ContractModule, K extends PushKeys<M>>(
    module: M,
    key: K,
    payload: PushProducerPayload<M, K>,
  ) => void;
};

// Every invoke (of one scope, when given), keyed by channel, for the
// stub fallback. Built from the same module list buildApi consumes so
// the inventory cannot drift from the api surface. Exported for the
// fake host's fixture wire (lab/fake-host/bridge.ts), which stubs the
// same way.
export function invokeIndexFor(
  scope?: ContractScope,
): Map<string, ContractCall> {
  const index = new Map<string, ContractCall>();
  for (const module of allContractModules) {
    if (scope !== undefined && scopeOf(module) !== scope) continue;
    for (const call of callsOf(module)) {
      if (isInvoke(call)) index.set(channelOf(call), call);
    }
  }
  return index;
}

export function createLocalRegistrar(): LocalRegistrar {
  const served = createServed<HandlerContext>();
  const fanOut = pushFanOut();
  const views = new Map<string, LocalView>();
  const invokeIndex = invokeIndexFor();
  // Fallback verdicts are computed once per channel: the policy is
  // deterministic and some stub outputs are sizeable object shapes. A
  // verdict is either a resolvable stub value or the refusal.
  type FallbackVerdict = { stub: unknown } | { refusal: BrowserRefusal };
  const verdictCache = new Map<string, FallbackVerdict>();

  function fallbackVerdict(
    channel: string,
    call: ContractCall,
  ): FallbackVerdict {
    const allowlisted = STUB_ALLOWED.has(channel);
    if (annotation(call, Gated) !== false && !allowlisted) {
      // Mutations, and local channels that never classified themselves
      // as reads, must not pretend to succeed.
      return {
        refusal: new BrowserRefusal({ channel, reason: "unavailable" }),
      };
    }
    const stub = stubValueFor(outputOf(call), { fabricateArms: allowlisted });
    if (stub === NO_STRUCTURAL_STUB) {
      // A read whose output demands a fabricated arm (an enum, a union,
      // a bounded scalar) gets no invented answer either.
      return {
        refusal: new BrowserRefusal({ channel, reason: "noSafeAnswer" }),
      };
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
          (decoded) => handler(decoded, context),
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
      const view = views.get(channel);
      if (view === undefined) {
        return Stream.fail(
          new BrowserRefusal({ channel, reason: "unavailable" }),
        );
      }
      return Stream.callback<unknown, unknown>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            view(input, {
              value: (value) => {
                Queue.offerUnsafe(queue, value);
              },
              end: (failure) => {
                if (failure === undefined) Queue.endUnsafe(queue);
                else Queue.failCauseUnsafe(queue, Cause.fail(failure));
              },
            }),
          ),
          (stop) => Effect.sync(stop),
        ),
      );
    },
  };

  return {
    served,
    link,
    view: (module, key, view) => {
      views.set(channelOf(callOf(module, key)), view);
    },
    push: (module, key, payload) => {
      const push = resolvePush(module, key, payload);
      fanOut.emit(push.channel, push.payload);
    },
  };
}
