// The app's logger, and the Promise-facing adapter for code that is not
// Effect (EFFECT.md, section 3), which writes the same lines without
// running an effect. A line goes to the console at its level, with a
// failure's cause after the message. In the desktop main process
// electron-log owns the console and writes it to ~/Library/Logs
// (main/electron/logFile.ts). In a renderer the console is the
// devtools'.
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import type * as LogLevel from "effect/LogLevel";

function write(level: LogLevel.LogLevel, parts: ReadonlyArray<unknown>) {
  switch (level) {
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
}

export const logger = Logger.make(({ logLevel, message, cause }) => {
  const parts: Array<unknown> = Array.isArray(message)
    ? [...message]
    : [message];
  if (cause.reasons.length > 0) parts.push(Cause.pretty(cause));
  write(logLevel, parts);
});

export const log = {
  info: (...message: ReadonlyArray<unknown>) => write("Info", message),
  warn: (...message: ReadonlyArray<unknown>) => write("Warn", message),
  error: (...message: ReadonlyArray<unknown>) => write("Error", message),
};

// A step that must not take its caller with it, run as an effect: its
// failure is a warning through the app's logger, and the caller carries
// on. For a step that needs no layer graph, so it runs whatever state
// the graph is in.
export const warnOnFailure = (
  label: string,
  step: () => unknown,
): Promise<void> =>
  Effect.runPromise(
    Effect.tryPromise(async () => step()).pipe(
      Effect.ignoreCause({ log: "Warn", message: label }),
      Effect.provide(Logger.layer([logger])),
    ),
  );
