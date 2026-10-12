// How the shell (main/hostProcess.ts) tells a host that answers from
// one that does not. A host whose loop is stuck holds its socket open
// and never exits, so nothing else would notice it: the shell asks it
// something cheap now and then, and one silent past the limit is
// killed, which forks it again like any exit. A quit or an update asks
// whether the host is busy and gives it a moment; a host that cannot
// say has nothing to lose to the quit.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// What a host says when asked whether it is busy, or none when it
// could not say in time (or at all).
export const busyWithin = <A, E>(
  busy: Effect.Effect<A, E>,
  deadline: Duration.Input,
): Effect.Effect<Option.Option<A>> =>
  busy.pipe(Effect.timeoutOption(deadline), Effect.orElseSucceed(Option.none));

// Asks `probe` every `every` while `watching` holds, and calls `silent`
// once a probe goes `limit` without an answer. A probe that fails is an
// answer: the host is there, and its link is what went (a restart the
// next probe sees). A round the machine slept through (`wakes` counts
// the wakes) proves nothing, since the clock ran on while the host could
// not answer, and the next round asks again.
export const watchHost = (options: {
  readonly probe: Effect.Effect<unknown, unknown>;
  readonly every: Duration.Input;
  readonly limit: Duration.Input;
  readonly watching: () => boolean;
  readonly wakes: () => number;
  readonly silent: () => void;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(options.every);
      if (!options.watching()) return;
      const woken = options.wakes();
      const answered = yield* options.probe.pipe(
        Effect.ignore,
        Effect.timeoutOption(options.limit),
      );
      if (!options.watching()) return;
      if (Option.isNone(answered) && options.wakes() === woken) {
        return options.silent();
      }
    }
  });
