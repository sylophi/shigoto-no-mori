// Spans for code that is not Effect yet: the Promise adapter of the
// process's tracer (EFFECT.md, section 3). The observability layer fills
// the context while the graph lives (host/lib/util/observability.ts). With none
// (a proof, or before boot) a traced run just runs. A step names its
// parent (the span handed to `run`). Otherwise the parent is the span a
// caller ran the Promise code under (withParentSpan): a move's step, or
// the device link serving a peer's call, so one move is one trace on
// every device it touches. The adapter goes once the last caller is an
// effect.
import { AsyncLocalStorage } from "node:async_hooks";
import type * as Context from "effect/Context";
import { callFailureOf } from "@shigomori/contracts/errors";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";

let context: Context.Context<never> | null = null;

const ambient = new AsyncLocalStorage<Tracer.AnySpan>();

// Runs `run` with `span` as the parent of the spans it makes, and of
// the calls it makes on a peer.
export function withParentSpan<A>(
  span: Option.Option<Tracer.AnySpan>,
  run: () => A,
): A {
  return Option.isNone(span) ? run() : ambient.run(span.value, run);
}

// Runs a step of a served call (registerHostContract's invoke) with the
// call's span as the ambient parent, so a Promise handler's spans and
// its calls on a peer continue the caller's trace. Scaffolding, like
// the Promise handlers it serves: it goes with the last of them.
export const invokeInCallSpan = <A>(run: () => A) =>
  Effect.flatMap(Effect.option(Effect.currentSpan), (span) =>
    Effect.try({ try: () => withParentSpan(span, run), catch: callFailureOf }),
  );

export function parentSpan(): Tracer.AnySpan | undefined {
  return ambient.getStore();
}

export function setTraceContext(next: Context.Context<never> | null): void {
  context = next;
}

export interface Span {
  readonly step: <A>(
    name: string,
    run: (span: Span) => Promise<A>,
    attributes?: Record<string, unknown>,
  ) => Promise<A>;
  readonly annotate: (key: string, value: unknown) => void;
}

const untraced: Span = {
  step: (_name, run) => run(untraced),
  annotate: () => {},
};

const handle = (span: Tracer.Span): Span => ({
  step: (name, run, attributes) => inSpan(name, run, attributes, span),
  annotate: (key, value) => span.attribute(key, value),
});

function inSpan<A>(
  name: string,
  run: (span: Span) => Promise<A>,
  attributes: Record<string, unknown> | undefined,
  parent: Tracer.Span | undefined,
): Promise<A> {
  if (context === null) return run(untraced);
  // A rejection is a defect here, which runPromise rejects with as it
  // was thrown, so callers still branch on its class.
  return Effect.runPromiseWith(context)(
    Effect.currentSpan.pipe(
      Effect.orDie,
      Effect.flatMap((span) => Effect.promise(() => run(handle(span)))),
      Effect.withSpan(name, { attributes, parent: parent ?? parentSpan() }),
    ),
  );
}

// A root span: `run` gets it to hang its steps on.
export const traced = <A>(
  name: string,
  attributes: Record<string, unknown>,
  run: (span: Span) => Promise<A>,
): Promise<A> => inSpan(name, run, attributes, undefined);
