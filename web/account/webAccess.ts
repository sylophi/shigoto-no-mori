// The typed "can this deployment serve a web client at all" state (v2
// step 5, slice B). Two conditions have no honest representation in the
// hub supervisor's phases and would otherwise surface as a silent
// retry loop or a dead button:
//
//   - "unconfigured": the account service variables were not baked into
//     this build, so there is no device hub to talk to.
//   - "blocked": the device hub answered the ticket mint with a 403.
//     The refusal is deterministic for the deployment, so retrying the
//     supervisor forever would loop without ever succeeding. The
//     device hub no longer refuses browser origins (its CORS is open,
//     since every route authenticates from the bearer alone), so this
//     is now the backstop for any other 403 rather than a config
//     mistake.
//
// The store is a tiny external-store (subscribe + snapshot) so React
// reads it through useSyncExternalStore, and the bridge factory owns
// one instance per bridge so the headless check drives it in isolation.

import { HubRequestError } from "@shared/account/service";

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

// True when the device hub refused the call outright with a 403. Keyed
// on the status rather than the message text: the refusal is terminal
// for this deployment whatever the worker's wording, and retrying
// cannot turn it into a success. A response the browser cannot read at
// all surfaces as an opaque fetch TypeError instead and is NOT
// classified here, so that path keeps the supervisor's honest backoff.
export function isHubRefusedError(error: unknown): boolean {
  return error instanceof HubRequestError && error.status === 403;
}

// True for the browser's opaque network failure shape (a fetch
// TypeError). Used by the UI's reachability probe to explain an
// unreachable device hub without treating it as terminal the way a 403
// is.
export function isFetchFailure(error: unknown): boolean {
  return error instanceof TypeError;
}
