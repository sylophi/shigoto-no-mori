// What a layer hands code that reads it from outside the graph's
// context (a handler's module state): a call that comes before the
// layer is up waits for it, and is refused only when the layer failed
// to start or has stopped with the app.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { errorMessageOf } from "@shigomori/contracts/errors";

export class LayerDownError extends Schema.TaggedError<LayerDownError>()(
  "LayerDownError",
  { name: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `${this.name} ${this.reason}.`;
  }
}

export const layerLatch = <T>(name: string) => {
  let ready = Deferred.makeUnsafe<T, LayerDownError>();
  let current: T | undefined;
  const settle = (exit: Exit.Exit<T, LayerDownError>) => {
    // A settled latch (a layer built again, or stopped) starts over.
    if (!Deferred.doneUnsafe(ready, exit)) {
      ready = Deferred.makeUnsafe<T, LayerDownError>();
      Deferred.doneUnsafe(ready, exit);
    }
  };
  return {
    // The value, once the layer is up.
    get: Effect.suspend(() => Deferred.await(ready)),
    // The value now, for a reader that cannot wait.
    now: (): T | undefined => current,
    // The layer, wrapping its acquisition: opens the latch with what it
    // built, refuses with why it failed, and refuses from its close on.
    provide: <E, R>(acquire: Effect.Effect<T, E, R>) =>
      acquire.pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            current = value;
            settle(Exit.succeed(value));
          }),
        ),
        Effect.tapCause((cause) =>
          Effect.sync(() =>
            settle(
              Exit.fail(
                new LayerDownError({
                  name,
                  reason: `failed to start: ${errorMessageOf(Cause.squash(cause))}`,
                }),
              ),
            ),
          ),
        ),
        Effect.tap(() =>
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              current = undefined;
              settle(
                Exit.fail(
                  new LayerDownError({ name, reason: "stopped with the app" }),
                ),
              );
            }),
          ),
        ),
      ),
  };
};
