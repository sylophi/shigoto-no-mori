// What the process's layer graph logs and traces through. A line goes
// to the app's logger (shared/log.ts), and one logged inside a span is
// also an event on it. Every span that ends is a JSON line in this
// device's trace.log (electron/logFile.ts). A dev build also streams its
// spans to the Effect devtools when they listen on their default port.
import { app } from "electron";
import * as Cause from "effect/Cause";
import * as DevTools from "effect/devtools/DevTools";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { logger } from "@shared/log";
import { writeTraceLine } from "./electron/logFile";

const millis = (nanos: bigint) => Number(nanos / 1_000_000n);

function outcome(exit: Exit.Exit<unknown, unknown>) {
  if (Exit.isSuccess(exit)) return { outcome: "ok" };
  if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: "interrupted" };
  return {
    outcome: "failed",
    error: errorMessageOf(Cause.squash(exit.cause)),
  };
}

const fileTracer = Tracer.make({
  span(options) {
    const span = Tracer.nativeTracer.span(options);
    const events: Array<{
      name: string;
      at: number;
      attributes?: Record<string, unknown>;
    }> = [];
    const event = span.event;
    span.event = function (name, startTime, attributes) {
      events.push({ name, at: millis(startTime), attributes });
      event.call(this, name, startTime, attributes);
    };
    const end = span.end;
    span.end = function (endTime, exit) {
      end.call(this, endTime, exit);
      const startTime = millis(span.status.startTime);
      writeTraceLine(
        JSON.stringify(
          {
            name: span.name,
            traceId: span.traceId,
            spanId: span.spanId,
            parentId: Option.getOrUndefined(span.parent)?.spanId,
            start: new Date(startTime).toISOString(),
            durationMs: millis(endTime) - startTime,
            ...outcome(exit),
            attributes: Object.fromEntries(span.attributes),
            events: events.length > 0 ? events : undefined,
          },
          (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
        ),
      );
    };
    return span;
  },
});

export const layer = Layer.mergeAll(
  Logger.layer([logger, Logger.tracerLogger]),
  Layer.succeed(Tracer.Tracer, fileTracer),
).pipe((base) =>
  app.isPackaged ? base : Layer.provideMerge(DevTools.layer(), base),
);
