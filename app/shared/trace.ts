// Spans for code that is not Effect yet: the Promise adapter of the
// process's tracer (EFFECT.md, section 3). The observability layer fills
// the context while the graph lives (main/observability.ts). With none
// (a proof, or before boot) a traced run just runs. Promise code has no
// ambient span, so a step names its parent: the span handed to `run`.
// The adapter goes once the last caller is an effect.
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Tracer from "effect/Tracer";

let context: Context.Context<never> | null = null;

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
      Effect.withSpan(name, { attributes, parent }),
    ),
  );
}

// A root span: `run` gets it to hang its steps on.
export const traced = <A>(
  name: string,
  attributes: Record<string, unknown>,
  run: (span: Span) => Promise<A>,
): Promise<A> => inSpan(name, run, attributes, undefined);
