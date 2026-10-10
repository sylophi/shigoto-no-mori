// What a process's layer graph logs and traces through, the shell's and
// the host's alike. A line goes to the app's logger (shared/log.ts),
// and one logged inside a span is also an event on it. Every span that
// ends is a JSON line handed to the process's trace file (the shell's
// main/electron/logFile.ts, the host's beside it). A dev build run with
// SHIGOMORI_DEVTOOLS=1 also streams its spans to the Effect devtools on
// their default port.
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as DevTools from "effect/devtools/DevTools";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { logger } from "@shared/log";

const millis = (nanos: bigint) => Number(nanos) / 1_000_000;

function outcome(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) return { outcome: "ok" };
  if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: "interrupted" };
  return {
    outcome: "failed",
    error: errorMessageOf(Cause.squash(exit.cause)),
  };
}

// An attribute that cannot be written (a cycle) costs the line its
// attributes, never the span's end.
function serialize(line: Record<string, unknown>): string {
  try {
    return JSON.stringify(line, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch {
    return JSON.stringify({
      ...line,
      attributes: "unserializable",
      events: undefined,
    });
  }
}

const fileTracer = (writeTraceLine: (line: string) => void) =>
  Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end;
      span.end = function (endTime, exit) {
        end.call(this, endTime, exit);
        const startTime = millis(span.status.startTime);
        writeTraceLine(
          serialize({
            name: span.name,
            traceId: span.traceId,
            spanId: span.spanId,
            parentId: Option.getOrUndefined(span.parent)?.spanId,
            start: new Date(startTime).toISOString(),
            durationMs: millis(endTime) - startTime,
            ...outcome(exit),
            attributes: Object.fromEntries(span.attributes),
            events:
              span.events.length > 0
                ? span.events.map(([name, at, attributes]) => ({
                    name,
                    at: millis(at),
                    attributes,
                  }))
                : undefined,
          }),
        );
      };
      return span;
    },
  });

// Opt-in, since the client waits up to a second for the devtools at
// boot and queues every span while they are not listening.
const devTools = (packaged: boolean) =>
  Layer.unwrap(
    Config.Boolean("SHIGOMORI_DEVTOOLS").pipe(
      Config.withDefault(false),
      Effect.map((on) => (on && !packaged ? DevTools.layer() : Layer.empty)),
      Effect.orElseSucceed(() => Layer.empty),
    ),
  );

export const layer = (options: {
  readonly packaged: boolean;
  readonly writeTraceLine: (line: string) => void;
}) =>
  devTools(options.packaged).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Logger.layer([logger, Logger.tracerLogger]),
        Layer.succeed(Tracer.Tracer, fileTracer(options.writeTraceLine)),
      ),
    ),
  );
