// The web bridge's in-page wire, the twin of main/preloadTransport.ts:
// one ServerTransport and one ClientTransport joined back to back, so
// the shared registrar
// (shared/ipc/registerContract.ts) mounts real browser-backed handlers
// exactly the way the Electron and socket bindings mount theirs, and
// buildApi consumes the client half exactly the way the preload consumes
// its IPC bridge. Nothing above or below this seam knows the wire is a
// Map.
//
// Channels no handler was registered for are answered FAIL-CLOSED:
//
//   - An invoke explicitly classified `mutating: false` (the socket
//     check forces every remote-exposed host invoke to classify itself,
//     and only reads carry false) may resolve to a schema-derived
//     structural stub (stubDefaults.ts), so a shared read-only
//     component renders an empty state instead of throwing.
//   - A channel on the small STUB_ALLOWED list below may stub too, with
//     fabricated enum/union arms permitted, because each entry has been
//     judged harmless by hand.
//   - EVERYTHING else rejects with a clear "not available in the
//     browser" error: mutations (`mutating: true`), unclassified
//     local-only channels, and any read whose output cannot be met
//     without fabricating an affirmative value. A future contract
//     channel therefore rejects by default until someone classifies it
//     as a read or allowlists it, so no mutation or permission-shaped
//     query can ever silently report success on the web.
//
// A channel absent from the contract entirely also rejects, because
// answering it would hide a real wiring bug.
import type { ContractScope, InvokeDef } from "@shared/ipc/contract";
import { allContractModules } from "@shared/ipc/client";
import { createSubscriberRegistry } from "@shared/ipc/socket/subscriberRegistry";
import type {
  ClientTransport,
  HandlerContext,
  ServerTransport,
} from "@shared/ipc/transport";
import { resolveBroadcast } from "@shared/ipc/registerContract";
import { NO_STRUCTURAL_STUB, stubValueFor } from "./stubDefaults";

// The hand-judged exceptions to the mutating:false rule. Every entry
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

export type LoopbackWire = {
  server: ServerTransport;
  client: ClientTransport;
};

// Every invoke def of one scope, keyed by channel, for the stub
// fallback. Built from the same module list buildApi consumes so the
// inventory cannot drift from the api surface. Exported for the lab's
// fixture wire (lab/bridge.ts), which stubs the same way.
export function invokeIndexFor(scope: ContractScope): Map<string, InvokeDef> {
  const index = new Map<string, InvokeDef>();
  for (const module of allContractModules) {
    if (module.scope !== scope) continue;
    for (const def of Object.values(module.calls)) {
      if (def.kind === "invoke") index.set(def.channel, def);
    }
  }
  return index;
}

export function createLoopbackWire(scope: ContractScope): LoopbackWire {
  const handlers = new Map<
    string,
    (ctx: HandlerContext, raw: unknown) => Promise<unknown>
  >();
  const subscribers = createSubscriberRegistry(`loopback:${scope}`);
  const invokeIndex = invokeIndexFor(scope);
  // Fallback verdicts are computed once per channel: the policy is
  // deterministic and some stub outputs are sizeable object shapes. A
  // verdict is either a resolvable stub value or the rejection message.
  type FallbackVerdict = { stub: unknown } | { refusal: string };
  const verdictCache = new Map<string, FallbackVerdict>();

  function fallbackVerdict(channel: string, def: InvokeDef): FallbackVerdict {
    const allowlisted = STUB_ALLOWED.has(channel);
    if (def.mutating !== false && !allowlisted) {
      // Mutations, and local channels that never classified themselves
      // as reads, must not pretend to succeed.
      return {
        refusal: `${channel} is not available in the browser`,
      };
    }
    const stub = stubValueFor(def.output, { fabricateArms: allowlisted });
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
  // peer, so it never aborts, matching the Electron binding's
  // same-document behavior.
  const pageLifetime = new AbortController();
  const context: HandlerContext = {
    notifier: (module, key) => (payload) => {
      const { channel, parsed } = resolveBroadcast(module, key, payload);
      subscribers.emit(channel, parsed);
    },
    signal: pageLifetime.signal,
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
    invoke(channel, input) {
      const handler = handlers.get(channel);
      if (handler !== undefined) {
        // Wrapped in a resolved-promise chain so a synchronous throw in
        // a handler rejects instead of escaping the transport contract.
        return Promise.resolve().then(() => handler(context, input));
      }
      const def = invokeIndex.get(channel);
      if (def === undefined) {
        return Promise.reject(
          new Error(`no handler and no contract entry for channel ${channel}`),
        );
      }
      let verdict = verdictCache.get(channel);
      if (verdict === undefined) {
        verdict = fallbackVerdict(channel, def);
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
  };

  return { server, client };
}
