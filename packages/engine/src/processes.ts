// What the engine asks of the processes on this machine.
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

// Signal 0 delivers nothing but still checks that the process exists.
// EPERM means it exists and isn't ours.
const signalZero = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Predicate.hasProperty(error, "code") && error.code === "EPERM";
  }
};

// Whether a process with the pid exists, whoever owns it.
export const pidAlive = (pid: number) => Effect.sync(() => signalZero(pid));
