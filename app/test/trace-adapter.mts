// The tracer's Promise adapter (host/lib/util/trace.ts), with a context as the
// app's graph fills it: a step is a child of the span it is run on,
// annotations land on the span, a rejection comes back as it was
// thrown (the move code branches on its class), and without a context
// a traced run just runs.
import assert from "node:assert/strict";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { afterEach, it } from "vitest";
import { setTraceContext, traced } from "@host/lib/util/trace";

type Ended = {
  name: string;
  spanId: string;
  parentId: string | undefined;
  attributes: Record<string, unknown>;
  ok: boolean;
};

function recording(): Ended[] {
  const ended: Ended[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end;
      span.end = function (endTime, exit) {
        end.call(this, endTime, exit);
        ended.push({
          name: span.name,
          spanId: span.spanId,
          parentId: Option.getOrUndefined(span.parent)?.spanId,
          attributes: Object.fromEntries(span.attributes),
          ok: Exit.isSuccess(exit),
        });
      };
      return span;
    },
  });
  setTraceContext(Context.make(Tracer.Tracer, tracer));
  return ended;
}

afterEach(() => setTraceContext(null));

class Refused extends Error {}

it("nests steps under the span they run on, with its annotations", async () => {
  const ended = recording();
  const result = await traced(
    "Sync.pull",
    { sourceWorktree: "w1" },
    async (span) => {
      span.annotate("captured", true);
      await span.step("Landing.create", (create) =>
        create.step("inner", async () => 1),
      );
      return span.step("Landing.tip", async () => "abc");
    },
  );
  assert.equal(result, "abc");
  const byName = new Map(ended.map((span) => [span.name, span]));
  const root = byName.get("Sync.pull");
  assert.ok(root);
  assert.equal(root.parentId, undefined);
  assert.deepEqual(root.attributes, { sourceWorktree: "w1", captured: true });
  assert.equal(byName.get("Landing.create")?.parentId, root.spanId);
  assert.equal(byName.get("Landing.tip")?.parentId, root.spanId);
  assert.equal(
    byName.get("inner")?.parentId,
    byName.get("Landing.create")?.spanId,
  );
});

it("rejects with the error as thrown and ends the span failed", async () => {
  const ended = recording();
  await assert.rejects(
    traced("Sync.send", {}, (span) =>
      span.step("Landing.apply", async () => {
        throw new Refused("no");
      }),
    ),
    (error) => error instanceof Refused && error.message === "no",
  );
  assert.deepEqual(
    ended.map((span) => [span.name, span.ok]),
    [
      ["Landing.apply", false],
      ["Sync.send", false],
    ],
  );
});

it("runs plainly with no context", async () => {
  assert.equal(
    await traced("x", {}, (span) => span.step("y", async () => 2)),
    2,
  );
});
