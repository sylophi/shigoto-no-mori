// Running an owner's callback where a throw has nowhere to go: inside
// a forked fiber (a defect there is reported nowhere, and it ends the
// fiber for good), on a timer, in a socket callback. The throw is
// logged as `<label>: <message>` and the caller carries on. `log`
// defaults to console.warn, read at the call so a proof that swaps it
// sees the line.
import { Cause, Effect, Exit, Fiber, PubSub, Scope, Stream } from "effect";
import { errorMessageOf } from "@shared/errorOf";

type Log = (message: string) => void;

function write(log: Log | undefined, message: string): void {
  if (log === undefined) console.warn(message);
  else log(message);
}

// The callback's result, or undefined when it threw.
export function containedSync<A>(
  label: string,
  fn: () => A,
  log?: Log,
): A | undefined {
  try {
    return fn();
  } catch (error) {
    write(log, `${label}: ${errorMessageOf(error)}`);
    return undefined;
  }
}

export const contained = (
  label: string,
  fn: () => void,
  log?: Log,
): Effect.Effect<void> =>
  Effect.sync(() => {
    containedSync(label, fn, log);
  });

// For Effect.catchCause at the end of a forked fiber: a failure that
// is not only its interruption is logged, and an interruption passes
// through as one.
export const logCauseUnlessInterrupt =
  (label: string, log?: Log) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.sync(() => write(log, `${label}: ${Cause.pretty(cause)}`));

// One call on a serving wire (the socket host, the control listener):
// the Promise handler runs to its answer, `ok` sends the result and
// `failed` the failure. A result that will not serialize (a cycle, a
// BigInt) makes `ok` throw and is answered as a failure, so the caller
// is never left waiting on the id. Anything past that is a bug, logged
// under `label` rather than ending the fiber with a defect nothing
// reports.
export const answerCall = (options: {
  run: () => Promise<unknown>;
  ok: (result: unknown) => void;
  failed: (error: unknown) => void;
  label: string;
  log?: Log;
}): Effect.Effect<void> =>
  Effect.tryPromise({ try: options.run, catch: (error) => error }).pipe(
    Effect.flatMap((result) =>
      Effect.try({ try: () => options.ok(result), catch: (error) => error }),
    ),
    Effect.catch((error) => Effect.sync(() => options.failed(error))),
    Effect.catchCause(logCauseUnlessInterrupt(options.label, options.log)),
  );

// A PubSub handed to a plain callback, one item at a time, on a
// subscriber fiber. Subscribed before this returns, so an item
// published right after reaches the listener, and an item already
// queued when the caller unsubscribes is not delivered. A throw from
// the listener is contained under `label`. Returns the unsubscribe.
export function followPubSub<A>(
  pubsub: PubSub.PubSub<A>,
  label: string,
  listener: (item: A) => void,
  runFork: (effect: Effect.Effect<void>) => Fiber.Fiber<void> = Effect.runFork,
): () => void {
  const scope = Scope.makeUnsafe();
  const subscription = Effect.runSync(
    PubSub.subscribe(pubsub).pipe(Scope.provide(scope)),
  );
  let active = true;
  const fiber = runFork(
    Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((item) =>
        contained(label, () => {
          if (active) listener(item);
        }),
      ),
    ),
  );
  return () => {
    if (!active) return;
    active = false;
    Effect.runFork(
      Fiber.interrupt(fiber).pipe(
        Effect.andThen(Scope.close(scope, Exit.void)),
      ),
    );
  };
}
