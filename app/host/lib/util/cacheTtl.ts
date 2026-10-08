import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";

// A Cache's time to live that keeps only answers: a failed lookup is
// asked again next time, so a transient failure can't pin a blank for
// the whole TTL.
export const answersFor =
  (ttl: Duration.Duration) =>
  <A, E>(exit: Exit.Exit<A, E>): Duration.Duration =>
    Exit.isSuccess(exit) ? ttl : Duration.zero;
