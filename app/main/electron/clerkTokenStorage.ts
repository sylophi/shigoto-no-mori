// ClerkTokens' Promise adapter (EFFECT.md, section 3), the storage the
// Clerk bridge is created with before app ready (clerk.ts), well before
// the graph is built. A call waits for the graph to build ClerkTokens.
import type { TokenStorage } from "@clerk/electron";
import type * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as ClerkTokens from "./ClerkTokens";

const context = Deferred.makeUnsafe<Context.Context<ClerkTokens.ClerkTokens>>();

const run = <A>(
  effect: Effect.Effect<
    A,
    KeyValueStore.KeyValueStoreError,
    ClerkTokens.ClerkTokens
  >,
): Promise<A> =>
  Effect.runPromise(
    Deferred.await(context).pipe(
      Effect.flatMap((filled) => Effect.provideContext(effect, filled)),
    ),
  );

export const clerkTokenStorage: TokenStorage = {
  getItem: (key) =>
    run(ClerkTokens.ClerkTokens.use((tokens) => tokens.getItem(key))),
  setItem: (key, value) =>
    run(ClerkTokens.ClerkTokens.use((tokens) => tokens.setItem(key, value))),
  removeItem: (key) =>
    run(ClerkTokens.ClerkTokens.use((tokens) => tokens.removeItem(key))),
};

// Filled once and kept: the bridge outlives no graph, and a graph whose
// later layers failed to build still built this one.
export const layer = (userData: string) =>
  Layer.effectDiscard(
    Effect.context<ClerkTokens.ClerkTokens>().pipe(
      Effect.flatMap((filled) => Deferred.succeed(context, filled)),
    ),
  ).pipe(Layer.provideMerge(ClerkTokens.layer(userData)));
