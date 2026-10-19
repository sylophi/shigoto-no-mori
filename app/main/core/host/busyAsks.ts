// What a quit or an update hears of what the host is busy with
// (hostProcess.ts's hostBusy), and whether the quit after it kills the
// host rather than wait on it to close: only a host that left the latest
// ask a quit acts on unanswered, while that ask still says something of
// it.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export function busyAsks<H, B>(options: {
  // What an unanswered ask reads as: a host that does not answer has
  // nothing to lose to a quit.
  readonly idle: B;
  // How long an unanswered ask says something of the host.
  readonly freshMs: number;
  readonly now: () => number;
}) {
  let unanswered: { readonly host: H; readonly at: number } | null = null;
  // Asks overlap (a quit during an unattended install): the latest
  // started is the one that says.
  let asks = 0;
  return {
    // `quitAfter`: a quit acts on this ask (Quit's, an install's), where
    // an update's look before anything is staged leaves none behind it.
    ask: (
      host: H | null,
      answer: Effect.Effect<Option.Option<B>>,
      quitAfter: boolean,
    ) =>
      Effect.suspend(() => {
        if (!quitAfter) {
          return Effect.map(
            answer,
            Option.getOrElse(() => options.idle),
          );
        }
        const ask = ++asks;
        return answer.pipe(
          Effect.tap((busy) =>
            Effect.sync(() => {
              if (ask !== asks) return;
              unanswered =
                Option.isNone(busy) && host !== null
                  ? { host, at: options.now() }
                  : null;
            }),
          ),
          Effect.map(Option.getOrElse(() => options.idle)),
        );
      }),
    kills: (running: H): boolean =>
      unanswered?.host === running &&
      options.now() - unanswered.at < options.freshMs,
  };
}
