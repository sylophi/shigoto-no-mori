// A process tree the host started, as each OS's ending reads it.
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
