// How the shell (main/hostProcess.ts) tells a host that answers from
// one that does not. A host whose loop is stuck holds its socket open
// and never exits, so nothing else would notice it: the shell asks it
// something cheap now and then, and one silent past the limit is
// killed, which forks it again like any exit. A quit or an update asks
// whether the host is busy and gives it a moment. A host that cannot
// say has nothing to lose to the quit.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { answerWithin } from "@shigomori/engine/liveness";

// What a host says when asked whether it is busy, or none when it
// could not say in time (or at all).
export const busyWithin = <A, E>(
  busy: Effect.Effect<A, E>,
  deadline: Duration.Input,
): Effect.Effect<Option.Option<A>> =>
  answerWithin(busy, Duration.toMillis(deadline)).pipe(
    Effect.map(Option.flatMap(Exit.getSuccess)),
  );

// Asks `probe` every `every` while `watching` holds, and calls `silent`
// once a probe goes `limit` without an answer. A probe that fails is an
// answer: the host is there, and its link is what went (a restart the
// next probe sees). One whose limit came late asks again
// (`answerWithin`): this process was not running (the machine asleep,
// the whole app stopped, or its loop held), and the host's answer may
// be waiting unread.
export const watchHost = (options: {
  readonly probe: Effect.Effect<unknown, unknown>;
  readonly every: Duration.Input;
  readonly limit: Duration.Input;
  readonly watching: () => boolean;
  readonly silent: () => void;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(options.every);
      if (!options.watching()) return;
      const answered = yield* answerWithin(
        options.probe,
        Duration.toMillis(options.limit),
      );
      if (!options.watching()) return;
      if (Option.isNone(answered)) return options.silent();
    }
  });

// A starting host's beats (host.ts posts one every few seconds from
// its first moment), as a probe for watchHost: `next` settles at the
// beat after it is asked. A host has no link to ask until it is up, and
// a loop stuck before then beats no more.
export const beats = (): {
  readonly beat: () => void;
  readonly next: Effect.Effect<void>;
} => {
  let waiting: Array<() => void> = [];
  return {
    beat: () => {
      const settled = waiting;
      waiting = [];
      for (const resolve of settled) resolve();
    },
    next: Effect.callback<void>((resume) => {
      const resolve = () => resume(Effect.void);
      waiting.push(resolve);
      return Effect.sync(() => {
        waiting = waiting.filter((other) => other !== resolve);
      });
    }),
  };
};
