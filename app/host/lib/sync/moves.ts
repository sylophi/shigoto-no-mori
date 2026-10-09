// The moves in flight on this host, so one can be cancelled: a pull or
// a send this device runs, or a mirror start (a send with a session on
// top). Each runs under an AbortSignal of its own, minted here and
// handed down through every step that can wait (the source link, the
// CLI child, the file transfer's poll), keyed the way the caller keys
// its progress: by the source worktree id, scoped to the calling peer,
// so a cancel finds exactly the move its caller asked for and never
// another device's. A landing this host runs for a peer's send is not
// here: its cancel is the link the sender tears down (sourceLink.ts,
// Link.closed), so it needs no key of its own.
//
// The signal also follows the caller's connection: a window that
// reloads or a peer whose socket dies (HandlerContext.signal) aborts
// the move the same way a cancel does, so nothing keeps landing for a
// caller that is gone. A pull or a send runs as one effect the signal
// interrupts (runCancellable): what a step made is undone by its
// finalizer (the created worktree removed, the link reset), and the
// call fails with MOVE_CANCELLED, whatever the step was waiting on
// said when it was cut short. Per-key rather than per-call because the
// wire has no request cancellation: a cancel frame and a per-call
// signal on the context would retire this registry.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MOVE_CANCELLED } from "@shigomori/contracts/modules/sync";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";
import { runTraced, withParentSpan } from "@host/lib/util/trace";
import type { HandlerContext } from "@shared/ipc/transport";
import { onAbort } from "@host/lib/util/abort";

class MoveCancelledError extends Error {
  constructor() {
    super(MOVE_CANCELLED);
    this.name = "MoveCancelledError";
  }
}

const inFlight = new Map<string, AbortController>();

function moveKey(
  ctx: Pick<HandlerContext, "callerDeviceId">,
  sourceWorktreeId: string,
): string {
  return `${ctx.callerDeviceId ?? ""}:${sourceWorktreeId}`;
}

// Runs a move under its own signal, registered for its length. One
// move per key at a time: the dialogs run one mutation per worktree,
// and a second by the same key while one runs is a bug worth refusing
// over, not a cancel of the first.
export async function runMove<T>(
  ctx: Pick<HandlerContext, "callerDeviceId" | "signal">,
  sourceWorktreeId: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const key = moveKey(ctx, sourceWorktreeId);
  if (inFlight.has(key)) {
    throw new Error("That worktree is already being moved. Wait for it.");
  }
  const controller = new AbortController();
  inFlight.set(key, controller);
  try {
    return await underSignal(
      AbortSignal.any([ctx.signal, controller.signal]),
      run,
    );
  } finally {
    inFlight.delete(key);
  }
}

// Whatever `run` threw once the signal fired is reported as the
// cancel: a reset link, a killed CLI child and a poll cut short all
// say something else, and the caller asked for exactly this.
async function underSignal<T>(
  signal: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await run(signal);
  } catch (error) {
    if (signal.aborted) throw new MoveCancelledError();
    throw error;
  }
}

// Cancels the move the caller has in flight by that key. False when
// there is none: it finished, or never reached this host.
export function cancelMove(
  ctx: Pick<HandlerContext, "callerDeviceId">,
  sourceWorktreeId: string,
): boolean {
  const controller = inFlight.get(moveKey(ctx, sourceWorktreeId));
  if (controller === undefined) return false;
  controller.abort();
  return true;
}

// A move run as one effect, for a Promise caller: the signal firing
// interrupts it, each step that made something undoes it in its
// finalizer, and the call fails with the cancel.
export function runCancellable<A, E>(
  signal: AbortSignal,
  move: Effect.Effect<A, E>,
): Promise<A> {
  return underSignal(signal, () =>
    runTraced(
      // A step's failure reaches the caller as it was thrown: the
      // surfaces branch on its class.
      move.pipe(Effect.mapError(unwrapStep)),
      { signal },
    ),
  );
}

// A step of a move that rejected. `cause` is what it threw.
export class MoveStepError extends Schema.TaggedError<MoveStepError>()(
  "MoveStepError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "A step of the move failed.";
  }
}

const isMoveStepError = Schema.is(MoveStepError);

// What a move's step threw, for the Promise caller.
export const unwrapStep = (error: unknown): unknown =>
  isMoveStepError(error) ? error.cause : error;

// One step of a move that waits on a promise. Interrupting the move
// aborts the signal it is given and waits for it to settle, so nothing
// it was writing is still running when a finalizer undoes the move.
// Its spans, and the peer calls it makes, are the move's.
export const step = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
    stepUnder(span, run),
  );

const stepUnder = <A>(
  span: Option.Option<Tracer.AnySpan>,
  run: (signal: AbortSignal) => Promise<A>,
) =>
  Effect.callback<A, MoveStepError>((resume, signal) => {
    const running = withParentSpan(span, () => run(signal));
    running.then(
      (value) => resume(Effect.succeed(value)),
      (cause: unknown) => resume(Effect.fail(new MoveStepError({ cause }))),
    );
    return Effect.promise(() =>
      running.then(
        () => {},
        () => {},
      ),
    );
  });

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MoveCancelledError();
}

// The promise, or the cancel, whichever comes first: for a wait that
// cannot itself be cut short (a peer's answer, the daemon's create).
// `onLate` takes what the promise resolves with after the cancel won
// (a session the daemon made anyway), so the caller can undo it.
export function abortable<T>(
  signal: AbortSignal | undefined,
  promise: Promise<T>,
  onLate?: (value: T) => unknown,
): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const off = onAbort(signal, () => {
      if (settled) return;
      settled = true;
      reject(new MoveCancelledError());
      promise.then((value) => onLate?.(value)).catch(() => {});
    });
    promise
      .then(
        (value) => {
          if (!settled) resolve(value);
        },
        (error: unknown) => {
          if (!settled) reject(error as Error);
        },
      )
      .finally(() => {
        settled = true;
        off();
      });
  });
}
