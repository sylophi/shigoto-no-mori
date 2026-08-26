// The typed "can this deployment serve a web client at all" state (v2
// step 5, slice B). Two conditions have no honest representation in the
// relay supervisor's phases and would otherwise surface as a silent
// retry loop or a dead button:
//
//   - "unconfigured": the SM_ACCOUNT_* variables were not baked into
//     this build, so there is no relay to talk to.
//   - "blocked": the relay refused this browser's Origin ("origin not
//     allowed", the ALLOWED_WEB_ORIGIN misconfiguration). The refusal
//     is deterministic for the deployment, so retrying the supervisor
//     forever would loop without ever succeeding.
//
// The store is a tiny external-store (subscribe + snapshot) so React
// reads it through useSyncExternalStore, and the bridge factory owns
// one instance per bridge so the headless check drives it in isolation.

export type WebAccessState =
  | { kind: "ok" }
  | { kind: "unconfigured" }
  | { kind: "blocked"; message: string };

export type WebAccessStore = {
  subscribe(listener: () => void): () => void;
  get(): WebAccessState;
  set(next: WebAccessState): void;
};

export function createWebAccessStore(): WebAccessStore {
  let state: WebAccessState = { kind: "ok" };
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => state,
    set(next) {
      if (state.kind === next.kind && state.kind !== "blocked") return;
      state = next;
      for (const listener of listeners) listener();
    },
  };
}

// The exact error body relay/src/worker.ts returns from its Origin
// gate. Matching on it is the same message-text contract the app uses
// for entity-gone errors (shared/errors.ts): the worker cannot reword
// it without this matcher following along.
const ORIGIN_BLOCKED_MESSAGE = "origin not allowed";

// True when a relay call failed because this origin is not allowed.
// Under node (the checks) and via any same-origin proxy the 403 body is
// readable and the message is exact. In a real browser the worker's 403
// carries no CORS headers, so the failure surfaces as an opaque fetch
// TypeError instead and is NOT classified here: that path keeps the
// supervisor's honest backoff (it is indistinguishable from being
// offline) and the devices page surfaces the possible misconfiguration
// through its own reachability probe.
export function isOriginBlockedError(error: unknown): boolean {
  return error instanceof Error && error.message === ORIGIN_BLOCKED_MESSAGE;
}

// True for the browser's opaque network failure shape (a fetch
// TypeError). Used by the UI's reachability probe to explain that an
// unreachable relay may mean an ALLOWED_WEB_ORIGIN misconfiguration,
// without treating it as terminal the way an exact origin refusal is.
export function isFetchFailure(error: unknown): boolean {
  return error instanceof TypeError;
}
