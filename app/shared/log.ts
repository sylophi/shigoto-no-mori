// The app's logger, and the Promise-facing adapter for code that is not
// Effect yet (EFFECT.md, section 3). A line goes to the console at its
// level, as console.* did, with a failure's cause after the message. In
// the desktop main process electron-log owns the console and writes it
// to ~/Library/Logs (main/electron/logFile.ts). In a renderer the
// console is the devtools'. The adapter goes once the last caller is an
// effect that logs through the graph's logger.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { errorMessageOf } from "@shigomori/contracts/errors";

export const logger = Logger.make(({ logLevel, message, cause }) => {
  const parts: Array<unknown> = Array.isArray(message)
    ? [...message]
    : [message];
  if (cause.reasons.length > 0) parts.push(Cause.pretty(cause));
  switch (logLevel) {
    case "Fatal":
    case "Error":
      console.error(...parts);
      return;
    case "Warn":
      console.warn(...parts);
      return;
    case "Info":
      console.info(...parts);
      return;
    default:
      console.debug(...parts);
  }
});

const withLogger = Effect.provideService(
  Logger.CurrentLoggers,
  new Set([logger]),
);

const write = (effect: Effect.Effect<void>) =>
  Effect.runSync(withLogger(effect));

export const log = {
  info: (...message: ReadonlyArray<unknown>) =>
    write(Effect.logInfo(...message)),
  warn: (...message: ReadonlyArray<unknown>) =>
    write(Effect.logWarning(...message)),
  error: (...message: ReadonlyArray<unknown>) =>
    write(Effect.logError(...message)),
};

// A step that must not take its caller with it: the failure degrades
// to a log line under the given label, the caller carries on.
export async function logFailure(
  label: string,
  run: () => unknown,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    log.warn(`${label}: ${errorMessageOf(error)}`);
  }
}
