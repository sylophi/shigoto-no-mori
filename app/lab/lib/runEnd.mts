// What a lab run starts that would outlive it (an app, a server, a
// folder) ends with the run, however the run ends: its own teardown, an
// exit, or a signal (Ctrl-C, a kill, the terminal closing) that would
// otherwise end the process with no teardown at all. `end` runs once,
// synchronously (a kill, a removal), and the signal then ends the
// process as it would have. The function returned forgets `end`, for a
// teardown that did the work itself.
const ends = new Set<() => void>();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
let listening = false;

function runEnds(): void {
  for (const end of ends) {
    ends.delete(end);
    try {
      end();
    } catch {
      // The rest still run.
    }
  }
}

function onSignal(name: NodeJS.Signals): void {
  runEnds();
  for (const each of SIGNALS) process.off(each, onSignal);
  process.kill(process.pid, name);
}

export function onRunEnd(end: () => void): () => void {
  if (!listening) {
    listening = true;
    process.once("exit", runEnds);
    for (const each of SIGNALS) process.on(each, onSignal);
  }
  ends.add(end);
  return () => {
    ends.delete(end);
  };
}

// A signal to `pid` that may have gone already.
export function signalIfAlive(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name);
  } catch {
    // Gone.
  }
}
