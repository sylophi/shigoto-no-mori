// ClerkTokens' Promise adapter (EFFECT.md, section 3), the storage the
// Clerk bridge is created with before app ready (clerk.ts), well before
// the graph is built. A call waits for the graph, which fills the
// context here as it builds ClerkTokens and empties it as it closes.
import type { TokenStorage } from "@clerk/electron";
import type * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ClerkTokens from "./ClerkTokens";

let context = Deferred.makeUnsafe<Context.Context<ClerkTokens.ClerkTokens>>();

const run = <A>(
  effect: Effect.Effect<A, never, ClerkTokens.ClerkTokens>,
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

export const layer = (userData: string) =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.context<ClerkTokens.ClerkTokens>().pipe(
        Effect.tap((filled) => Deferred.succeed(context, filled)),
      ),
      () =>
        Effect.sync(() => {
          context = Deferred.makeUnsafe();
        }),
    ),
  ).pipe(Layer.provideMerge(ClerkTokens.layer(userData)));
