// The app instance's client store (theme, palettes, villageLife,
// keepReachable, the sidebar's view and folds), as its owner streams it
// (clientConfig:watch: the shell on the desktop, the tab on the web), so
// every window follows one copy. Device-wide settings stay in
// useGlobalConfig.
//
// A change is a patch of its own keys (patchClientConfig), applied by
// the store's owner over the config as it stands, so one window's
// write never puts back what another changed. Until the store's owner
// hands the patched config back, this window shows the patch over what
// it had: a second press reads the first one's value.
import { callOf } from "@shigomori/contracts/contract";
import { clientConfigContract } from "@shigomori/contracts/modules/clientConfig";
import type { ClientConfig } from "@shigomori/contracts/schemas";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Stream from "effect/Stream";
import { ClientLinks } from "@/lib/runtime/ClientLinks";
import { clientAtoms, viewOn } from "@/lib/runtime/atoms";
import type { RendererApi } from "@/lib/runtime/pageApi";
import {
  firstValueOf,
  type LiveViewState,
  useView,
  useViewErrorToast,
  whenViewShows,
} from "@/lib/runtime/viewHooks";

const storedAtom = Atom.keepAlive(
  clientAtoms.atom(
    Stream.unwrap(
      Effect.gen(function* () {
        const { linkOf } = yield* ClientLinks;
        return viewOn(
          linkOf(clientConfigContract),
          callOf(clientConfigContract, "watch"),
          undefined,
        );
      }),
    ),
  ),
) as Atom.Atom<AsyncResult.AsyncResult<ClientConfig, unknown>>;

// This window's patches the store's owner has not handed back yet.
const pendingAtom = Atom.keepAlive(
  Atom.make<ReadonlyArray<Partial<ClientConfig>>>([]),
);

const applied = (
  config: ClientConfig,
  patch: Partial<ClientConfig>,
): ClientConfig => {
  const next: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as ClientConfig;
};

export const clientConfigAtom = Atom.readable((get) => {
  const stored = get(storedAtom);
  const pending = get(pendingAtom);
  return AsyncResult.map(stored, (config) => pending.reduce(applied, config));
});

export function useClientConfig(): LiveViewState<ClientConfig> {
  const state = useView(clientConfigAtom);
  useViewErrorToast(state, "Couldn't load appearance settings");
  return state;
}

// The config as this window shows it now, for a handler outside React
// (a key press), or undefined before it has loaded.
export function clientConfigNow(
  registry: AtomRegistry.AtomRegistry,
): ClientConfig | undefined {
  const result = registry.get(clientConfigAtom);
  return AsyncResult.isSuccess(result) ? result.value : undefined;
}

// The config once it has loaded, for a reader outside React.
export function clientConfigOnce(
  registry: AtomRegistry.AtomRegistry,
): Promise<ClientConfig | undefined> {
  return firstValueOf(registry, clientConfigAtom);
}

// Sets the patch's keys, and clears the ones it gives as undefined
// (back to their default: the store's omit-on-default serialization).
// Shown in this window at once; a failed patch takes it back.
export async function patchClientConfig(
  api: Pick<RendererApi, "clientConfig" | "run">,
  registry: AtomRegistry.AtomRegistry,
  patch: Partial<ClientConfig>,
): Promise<void> {
  const set: Record<string, unknown> = {};
  const clear: (keyof ClientConfig)[] = [];
  for (const [key, value] of Object.entries(patch) as [
    keyof ClientConfig,
    unknown,
  ][]) {
    if (value === undefined) clear.push(key);
    else set[key] = value;
  }
  registry.update(pendingAtom, (pending) => [...pending, patch]);
  const settle = () =>
    registry.update(pendingAtom, (pending) =>
      pending.filter((held) => held !== patch),
    );
  try {
    await api.run(api.clientConfig.patch({ set: set as ClientConfig, clear }));
  } catch (error) {
    settle();
    throw error;
  }
  // Held until the store's owner hands back a config that has it, so
  // the window never shows the value it had in between.
  await whenViewShows(registry, storedAtom, (config) =>
    Object.entries(patch).every(([key, value]) =>
      value === undefined
        ? !(key in config)
        : JSON.stringify(config[key as keyof ClientConfig]) ===
          JSON.stringify(value),
    ),
  );
  settle();
}
