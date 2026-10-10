// The tab's local registrar: what a browser serves itself, in the page.
// A web client is a device with no host (decision 6 of V3.md): every
// host it shows is a peer, reached over the device link through the
// hub (shared/hub/directPlane.ts). What stays in the page are the
// client modules (the account, the client config, the hub bridge, the
// shell, the releases) and the browser's own copy of the shared
// settings, mounted through the shared registrar
// (shared/ipc/registerContract.ts) like every binding's, and called
// through buildApi like every window's.
//
// A host call nothing here serves is the renderer asking a local host
// the browser does not have, which it still does in a few places until
// step 6 makes "local" one device in the list. Those are answered
// FAIL-CLOSED:
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
  callsOf,
  channelOf,
  type ContractCall,
  type ContractScope,
  Gated,
  isInvoke,
  outputOf,
  scopeOf,
} from "@shigomori/contracts/contract";
import { allContractModules } from "@shigomori/contracts/allModules";
import { createSubscriberRegistry } from "@shared/remote/subscriberRegistry";
import type {
  ClientTransport,
  HandlerContext,
  ServerTransport,
} from "@shared/ipc/transport";
import { resolveBroadcast } from "@shared/ipc/registerContract";
import type { ViewObserver } from "@shigomori/contracts/types";
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

// A view the page serves itself (hub:watchPeer), observed until the
// returned stop.
type LocalView = (
  input: unknown,
  observer: ViewObserver<unknown>,
) => () => void;

export type LocalRegistrar = {
  server: ServerTransport;
  client: ClientTransport;
  view: (channel: string, view: LocalView) => void;
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
  const handlers = new Map<
    string,
    (ctx: HandlerContext, raw: unknown) => Promise<unknown>
  >();
  const subscribers = createSubscriberRegistry("tab");
  const views = new Map<string, LocalView>();
  const invokeIndex = invokeIndexFor();
  // Fallback verdicts are computed once per channel: the policy is
  // deterministic and some stub outputs are sizeable object shapes. A
  // verdict is either a resolvable stub value or the rejection message.
  type FallbackVerdict = { stub: unknown } | { refusal: string };
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
        refusal: `${channel} is not available in the browser`,
      };
    }
    const stub = stubValueFor(outputOf(call), { fabricateArms: allowlisted });
    if (stub === NO_STRUCTURAL_STUB) {
      // A read whose output demands a fabricated arm (an enum, a union,
      // a bounded scalar) gets no invented answer either.
      return {
        refusal: `${channel} has no safe empty answer in the browser`,
      };
    }
    return { stub };
  }

  // One handler context for the page's lifetime. The signal seam exists
  // for callers that outlive their peer; in-page the caller IS the
  // peer, so it never aborts.
  const pageLifetime = new AbortController();
  const context: HandlerContext = {
    notifier: (module, key) => (payload) => {
      const { channel, parsed } = resolveBroadcast(module, key, payload);
      subscribers.emit(channel, parsed);
    },
    signal: pageLifetime.signal,
    connection: pageLifetime.signal,
  };

  const server: ServerTransport = {
    handle(channel, fn) {
      handlers.set(channel, (ctx, raw) => fn(ctx, raw));
    },
    broadcastAll(channel, payload) {
      subscribers.emit(channel, payload);
    },
  };

  const client: ClientTransport = {
    local: true,
    invoke(channel, input) {
      const handler = handlers.get(channel);
      if (handler !== undefined) {
        // Wrapped in a resolved-promise chain so a synchronous throw in
        // a handler rejects instead of escaping the transport contract.
        return Promise.resolve().then(() => handler(context, input));
      }
      const call = invokeIndex.get(channel);
      if (call === undefined) {
        return Promise.reject(
          new Error(`no handler and no contract entry for channel ${channel}`),
        );
      }
      let verdict = verdictCache.get(channel);
      if (verdict === undefined) {
        verdict = fallbackVerdict(channel, call);
        verdictCache.set(channel, verdict);
      }
      if ("refusal" in verdict) {
        return Promise.reject(new Error(verdict.refusal));
      }
      return Promise.resolve(verdict.stub);
    },
    subscribe(channel, handler) {
      return subscribers.subscribe(channel, handler);
    },
    watch(channel, input, observer) {
      const view = views.get(channel);
      if (view === undefined) {
        observer.end(new Error(`${channel} is not available in the browser`));
        return () => {};
      }
      return view(input, observer);
    },
  };

  return {
    server,
    client,
    view: (channel, view) => {
      views.set(channel, view);
    },
  };
}
