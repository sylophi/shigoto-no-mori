// Proof for the guide's sessions in the shell (main/core/guide/Guide.ts),
// over windows that stand in for Electron's: a session's token is minted
// fresh for the window that asked and drives that window alone; it is
// refused once the window stops it, asks again or closes, and once the
// shell quits; and the guide is refused a click on a control that
// deletes, a key on one, and any text or key in a terminal, each before
// anything reaches the page. Also the outline `look` answers
// (axOutline.ts).
//
// Run: pnpm test guide.
import assert from "node:assert/strict";
import type { GuideState } from "@shigomori/contracts/modules/guide";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { it } from "vitest";
import { axOutline } from "../main/core/guide/axOutline.ts";
import * as Guide from "../main/core/guide/Guide.ts";

type Facts = { destructive: boolean; terminal: boolean };

// A window's page: what each node and the focus are, and every command
// the guide sent it.
function makeWindow(windowId: number) {
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  const window = {
    windowId,
    sent,
    attached: false,
    detached: false,
    nodes: new Map<number, Facts>(),
    focused: { destructive: false, terminal: false } as Facts,
    inputs: () =>
      sent.filter(({ method }) => method.startsWith("Input.")).length,
  };
  const page: Guide.GuidePage = {
    send: (method, params) =>
      Effect.sync(() => {
        sent.push({ method, params });
        if (method === "DOM.resolveNode") {
          const ref = params?.["backendNodeId"] as number;
          return window.nodes.has(ref)
            ? { object: { objectId: `${ref}` } }
            : {};
        }
        if (method === "Runtime.callFunctionOn") {
          const facts = window.nodes.get(Number(params?.["objectId"]));
          return { result: { value: { ...facts, x: 10, y: 10 } } };
        }
        if (method === "Runtime.evaluate") {
          return { result: { value: window.focused } };
        }
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        return {};
      }),
    route: Effect.succeed(`/window/${windowId}`),
    navigate: () => Effect.void,
    screenshot: Effect.succeed("cG5n"),
    settle: Effect.void,
  };
  return { window, page };
}

// The shell's guide over two windows, 1 and 2, with what each was told.
function makeShell() {
  const windows = new Map([
    [1, makeWindow(1)],
    [2, makeWindow(2)],
  ]);
  const told: { windowId: number; state: GuideState | null }[] = [];
  const layer = Guide.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Guide.GuideWindows,
        Guide.GuideWindows.of({
          attach: (windowId) => {
            const held = windows.get(windowId);
            if (held === undefined) {
              return Effect.fail(new Guide.GuideSessionEnded());
            }
            return Effect.acquireRelease(
              Effect.sync(() => {
                held.window.attached = true;
                return held.page;
              }),
              () =>
                Effect.sync(() => {
                  held.window.detached = true;
                }),
            );
          },
          tell: (windowId, state) =>
            Effect.sync(() => void told.push({ windowId, state })),
        }),
      ),
    ),
  );
  return {
    window: (id: number) => {
      const held = windows.get(id);
      if (held === undefined) throw new Error(`no window ${id}`);
      return held.window;
    },
    told,
    layer,
  };
}

const run = <A, E>(
  layer: Layer.Layer<Guide.Guide>,
  use: (guide: Guide.Guide["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Guide.Guide, use).pipe(Effect.provide(layer))),
  );

const failure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

const ended = (exit: Exit.Exit<unknown, unknown>) =>
  failure(exit) instanceof Guide.GuideSessionEnded;

const refusedFor = (exit: Exit.Exit<unknown, unknown>) => {
  const error = failure(exit);
  return error instanceof Guide.GuideRefused ? error.reason : undefined;
};

it("mints a fresh token for each ask and drives the window it was minted for alone", async () => {
  const shell = makeShell();
  await run(shell.layer, (guide) =>
    Effect.gen(function* () {
      const one = yield* guide.start(1, "claude");
      const two = yield* guide.start(2, "codex");
      // 32 random bytes each, as base64url.
      assert.match(one, /^[\w-]{43}$/);
      assert.notEqual(one, two);
      assert.ok(
        ended(
          yield* Effect.exit(guide.drive("x".repeat(43), { _tag: "look" })),
        ),
      );

      const reply = yield* guide.drive(one, { _tag: "look" });
      assert.equal(reply.route, "/window/1");
      assert.ok(shell.window(1).attached);
      assert.ok(!shell.window(2).attached);
      assert.equal(
        (yield* guide.drive(two, { _tag: "screenshot" })).route,
        "/window/2",
      );

      // Each window hears its own guide.
      assert.deepEqual(yield* guide.read(1), {
        harness: "claude",
        point: null,
      });
      assert.deepEqual(yield* guide.read(2), { harness: "codex", point: null });
      assert.ok(
        shell.told.some(
          (entry) => entry.windowId === 1 && entry.state?.harness === "claude",
        ),
      );
    }),
  );
});

it("refuses a token once its window stops it, asks again or closes", async () => {
  const shell = makeShell();
  await run(shell.layer, (guide) =>
    Effect.gen(function* () {
      const first = yield* guide.start(1, "claude");
      yield* guide.drive(first, { _tag: "look" });
      const second = yield* guide.start(1, "claude");
      assert.ok(
        ended(yield* Effect.exit(guide.drive(first, { _tag: "look" }))),
      );
      // The old session let go of the page, and the mark it left.
      assert.ok(shell.window(1).detached);
      assert.ok(
        shell
          .window(1)
          .sent.some(
            ({ method, params }) =>
              method === "Runtime.evaluate" &&
              String(params?.["expression"]).includes("removeAttribute"),
          ),
      );

      yield* guide.drive(second, { _tag: "look" });
      // Stop, and a closed window, both arrive as the window's end.
      yield* guide.end(1);
      assert.ok(
        ended(yield* Effect.exit(guide.drive(second, { _tag: "look" }))),
      );
      assert.equal(yield* guide.read(1), null);
      assert.deepEqual(shell.told.at(-1), { windowId: 1, state: null });
      // Ending a window with no session does nothing.
      yield* guide.end(2);
    }),
  );
});

it("ends every session when the shell quits", async () => {
  const shell = makeShell();
  const scope = await Effect.runPromise(Scope.make());
  const guide = await Effect.runPromise(
    Layer.buildWithScope(shell.layer, scope).pipe(
      Effect.map((context) => Context.get(context, Guide.Guide)),
    ),
  );
  const token = await Effect.runPromise(guide.start(1, "claude"));
  await Effect.runPromise(guide.drive(token, { _tag: "look" }));
  await Effect.runPromise(Scope.close(scope, Exit.void));
  assert.ok(shell.window(1).detached);
});

it("refuses a click or a key on a control that deletes, before it reaches the page", async () => {
  const shell = makeShell();
  const page = shell.window(1);
  page.nodes.set(7, { destructive: true, terminal: false });
  page.nodes.set(8, { destructive: false, terminal: false });
  await run(shell.layer, (guide) =>
    Effect.gen(function* () {
      const token = yield* guide.start(1, "claude");
      assert.equal(
        refusedFor(
          yield* Effect.exit(guide.drive(token, { _tag: "click", ref: 7 })),
        ),
        "destructive",
      );
      assert.equal(page.inputs(), 0);

      page.focused = { destructive: true, terminal: false };
      for (const key of ["Enter", "Space"] as const) {
        assert.equal(
          refusedFor(
            yield* Effect.exit(guide.drive(token, { _tag: "press", key })),
          ),
          "destructive",
        );
      }
      assert.equal(page.inputs(), 0);
      // Moving off it is the guide's to do.
      yield* guide.drive(token, { _tag: "press", key: "Tab" });
      assert.equal(page.inputs(), 2);

      // A plain control takes the click: a move, a press and a release.
      yield* guide.drive(token, { _tag: "click", ref: 8 });
      assert.equal(page.inputs(), 5);
    }),
  );
});

it("refuses any text or key in a terminal, before it reaches the page", async () => {
  const shell = makeShell();
  const page = shell.window(1);
  page.nodes.set(9, { destructive: false, terminal: true });
  page.nodes.set(10, { destructive: false, terminal: false });
  await run(shell.layer, (guide) =>
    Effect.gen(function* () {
      const token = yield* guide.start(1, "codex");
      assert.equal(
        refusedFor(
          yield* Effect.exit(
            guide.drive(token, { _tag: "fill", ref: 9, text: "rm -rf ~" }),
          ),
        ),
        "terminal",
      );
      page.focused = { destructive: false, terminal: true };
      for (const key of ["Enter", "Escape", "ArrowUp"] as const) {
        assert.equal(
          refusedFor(
            yield* Effect.exit(guide.drive(token, { _tag: "press", key })),
          ),
          "terminal",
        );
      }
      assert.equal(page.inputs(), 0);

      // A field elsewhere takes the text.
      yield* guide.drive(token, {
        _tag: "fill",
        ref: 10,
        text: "feature/mirror",
      });
      assert.deepEqual(
        page.sent
          .filter(({ method }) => method === "Input.insertText")
          .map(({ params }) => params),
        [{ text: "feature/mirror" }],
      );
    }),
  );
});

it("refuses every action after Stop, and a ref no longer on the page", async () => {
  const shell = makeShell();
  const page = shell.window(1);
  page.nodes.set(11, { destructive: false, terminal: false });
  await run(shell.layer, (guide) =>
    Effect.gen(function* () {
      const token = yield* guide.start(1, "claude");
      yield* guide.drive(token, { _tag: "point", ref: 11, say: "This one." });
      assert.deepEqual(yield* guide.read(1), {
        harness: "claude",
        point: { say: "This one.", seq: 1 },
      });
      assert.ok(
        failure(
          yield* Effect.exit(guide.drive(token, { _tag: "click", ref: 404 })),
        ) instanceof Guide.GuideTargetGone,
      );

      yield* guide.end(1);
      const before = page.sent.length;
      for (const action of [
        { _tag: "look" },
        { _tag: "screenshot" },
        { _tag: "navigate", route: "/settings" },
        { _tag: "click", ref: 11 },
        { _tag: "fill", ref: 11, text: "x" },
        { _tag: "press", key: "Enter" },
        { _tag: "point", ref: 11, say: "Here." },
        { _tag: "clear" },
      ] as const) {
        assert.ok(ended(yield* Effect.exit(guide.drive(token, action))));
      }
      assert.equal(page.sent.length, before);
    }),
  );
});

it("outlines the accessibility tree: one line a control, with its ref and state", () => {
  const outline = axOutline({
    nodes: [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      { nodeId: "2", role: { value: "generic" }, childIds: ["3", "5", "7"] },
      {
        nodeId: "3",
        role: { value: "heading" },
        name: { value: "Settings" },
        backendDOMNodeId: 41,
        properties: [{ name: "level", value: { value: 1 } }],
        childIds: ["4"],
      },
      {
        nodeId: "4",
        role: { value: "StaticText" },
        name: { value: "Settings" },
      },
      {
        nodeId: "5",
        role: { value: "button" },
        name: { value: "Save" },
        backendDOMNodeId: 57,
        properties: [
          { name: "disabled", value: { value: true } },
          { name: "focused", value: { value: false } },
        ],
      },
      { nodeId: "6", ignored: true, role: { value: "none" } },
      {
        nodeId: "7",
        role: { value: "textbox" },
        name: { value: "Name" },
        value: { value: "mori" },
        backendDOMNodeId: 60,
      },
    ],
  });
  assert.equal(
    outline,
    [
      '- heading "Settings" [ref=41] level=1',
      '- button "Save" [ref=57] disabled',
      '- textbox "Name" [ref=60] value="mori"',
    ].join("\n"),
  );
});
