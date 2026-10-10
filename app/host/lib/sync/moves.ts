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
// interrupts (cancellable): what a step made is undone by its
// finalizer (the created worktree removed, the link reset), and the
// call fails with MOVE_CANCELLED, whatever the step was waiting on
// said when it was cut short. Per-key rather than per-call because the
// wire has no request cancellation: a cancel frame and a per-call
// signal on the context would retire this registry.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MOVE_CANCELLED } from "@shigomori/contracts/modules/sync";
import type { HandlerContext } from "@shared/ipc/transport";
import { onAbort } from "@host/lib/util/abort";

class MoveCancelledError extends Schema.TaggedError<MoveCancelledError>()(
  "MoveCancelledError",
  {},
) {
  override get message(): string {
    return MOVE_CANCELLED;
  }
}

class MoveBusyError extends Schema.TaggedError<MoveBusyError>()(
  "MoveBusyError",
  {},
) {
  override get message(): string {
    return "That worktree is already being moved. Wait for it.";
  }
}

const inFlight = new Map<string, AbortController>();

function moveKey(
  ctx: Pick<HandlerContext, "callerDeviceId">,
  sourceWorktreeId: string,
): string {
  return `${ctx.callerDeviceId ?? ""}:${sourceWorktreeId}`;
}

// Runs a move under its own signal, registered for its length (see
// cancellable). One move per key at a time: the dialogs run one
// mutation per worktree, and a second by the same key while one runs
// is a bug worth refusing over, not a cancel of the first.
export const runMove = <A, E, R>(
  ctx: Pick<HandlerContext, "callerDeviceId" | "signal">,
  sourceWorktreeId: string,
  run: (signal: AbortSignal) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MoveBusyError | MoveCancelledError, R> =>
  Effect.suspend(
    (): Effect.Effect<A, E | MoveBusyError | MoveCancelledError, R> => {
      const key = moveKey(ctx, sourceWorktreeId);
      if (inFlight.has(key)) return Effect.fail(new MoveBusyError());
      const controller = new AbortController();
      inFlight.set(key, controller);
      const signal = AbortSignal.any([ctx.signal, controller.signal]);
      return cancellable(signal, run(signal)).pipe(
        Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
      );
    },
  );

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

// A move run as one effect: the signal firing interrupts it, each step
// that made something undoes it in its finalizer, and the move fails
// with the cancel, whatever the step it was waiting on said when it
// was cut short (a reset link, a killed child, a poll cut short).
export const cancellable = <A, E, R>(
  signal: AbortSignal,
  move: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | MoveCancelledError, R> =>
  move.pipe(
    Effect.raceFirst(
      Effect.callback<never, MoveCancelledError>((resume) => {
        const off = onAbort(signal, () =>
          resume(Effect.fail(new MoveCancelledError())),
        );
        return Effect.sync(off);
      }),
    ),
    Effect.mapError((error) =>
      signal.aborted ? new MoveCancelledError() : error,
    ),
  );
