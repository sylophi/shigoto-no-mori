// What a quit or an update hears of what the host is busy with
// (hostProcess.ts's hostBusy), and whether the quit after it kills the
// host rather than wait on it to close: only a host that left the last
// ask a quit acts on unanswered.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export function busyAsks<H, B>(options: {
  // What an unanswered ask reads as: a host that does not answer has
  // nothing to lose to a quit.
  readonly idle: B;
}) {
  let unanswered: H | null = null;
  return {
    // `quitAfter`: a quit acts on this ask (Quit's, an install's), where
    // an update's look before anything is staged leaves none behind it.
    ask: (
      host: H | null,
      answer: Effect.Effect<Option.Option<B>>,
      quitAfter: boolean,
    ) =>
      answer.pipe(
        Effect.tap((busy) =>
          Effect.sync(() => {
            if (quitAfter) unanswered = Option.isNone(busy) ? host : null;
          }),
        ),
        Effect.map(Option.getOrElse(() => options.idle)),
      ),
    kills: (running: H): boolean => unanswered === running,
  };
}
