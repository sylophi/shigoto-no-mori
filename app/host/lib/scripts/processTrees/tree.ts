// A process tree the host started, as each OS's ending reads it, and
// how it is stopped.
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export type Tree = {
  readonly pid: number;
  // A PTY run's shell leads a group, and a lifecycle script runs in the
  // host's.
  readonly ownGroup: boolean;
  // Closes the PTY a run's tree is attached to, while the host holds
  // it: the hangup where no signal is one.
  readonly closeTerminal?: () => void;
  // Types Ctrl+C into that PTY: the stop where no signal is one.
  readonly interrupt?: () => void;
};

export type Stop = {
  // A stop, or a hangup, which an interactive shell (ignoring a stop)
  // ends on.
  readonly how: "stop" | "hangup";
  // How long the tree has to end once asked, before it is ended.
  readonly graceMs: number;
  // How long it has to go once ended, before it is given up on.
  readonly endMs: number;
  // Completes once the tree is gone, however the caller hears it.
  readonly exited: Effect.Effect<unknown>;
  // The tree in the warning about one that outlived its end.
  readonly name: string;
};

export const exitedWithin = (stop: Stop, ms: number) =>
  stop.exited.pipe(
    Effect.timeoutOption(Duration.millis(ms)),
    Effect.map(Option.isSome),
  );
