// The guide's sessions and what they do in a window (contracts'
// modules/guide.ts). A window that asks gets a session: a token bound to
// that window alone, which `sm guide mcp` presents with every action. A
// session ends when its window stops it, asks again, or closes, and its
// token is refused from then. The window's page is driven through the
// DevTools protocol, attached at a session's first action and detached
// as it ends.
//
// Some controls are the user's alone: one that deletes, removes or signs
// out (a `data-variant` ending in "destructive"), which a click or a key
// on it is refused for, and the app's terminals, which take no keys or
// text from a guide.
import { randomBytes } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type {
  GuideAction,
  GuideHarness,
  GuideKey,
  GuideReply,
  GuideState,
} from "@shigomori/contracts/modules/guide";
import { axOutline } from "./axOutline";

// Each error carries a code, which the wire keeps beside the message.

export class GuideSessionEnded extends Schema.TaggedError<GuideSessionEnded>()(
  "GuideSessionEnded",
  {},
) {
  get code(): string {
    return "guide-ended";
  }

  override get message(): string {
    return "This guide has ended: the user stopped it or closed its window.";
  }
}

export class GuideRefused extends Schema.TaggedError<GuideRefused>()(
  "GuideRefused",
  { reason: Schema.Literals(["destructive", "terminal"]) },
) {
  get code(): string {
    return "guide-refused";
  }

  override get message(): string {
    return this.reason === "destructive"
      ? "That control is the user's to use: it deletes, removes or signs out. Point at it and let them decide."
      : "The app's terminals are the user's. Use your own shell instead.";
  }
}

export class GuideTargetGone extends Schema.TaggedError<GuideTargetGone>()(
  "GuideTargetGone",
  { ref: Schema.Int },
) {
  get code(): string {
    return "guide-stale-ref";
  }

  override get message(): string {
    return `Ref ${this.ref} is no longer in the window. Look again.`;
  }
}

export class GuidePageFailed extends Schema.TaggedError<GuidePageFailed>()(
  "GuidePageFailed",
  { method: Schema.String, cause: Schema.Defect() },
) {
  get code(): string {
    return "guide-page";
  }

  override get message(): string {
    return `The window didn't answer ${this.method}.`;
  }
}

// A window's page, as the guide drives it.
export type GuidePage = {
  // One DevTools protocol command.
  readonly send: (
    method: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<unknown, GuidePageFailed>;
  // The route the window shows.
  readonly route: Effect.Effect<string>;
  readonly navigate: (route: string) => Effect.Effect<void>;
  // The window as a PNG, base64.
  readonly screenshot: Effect.Effect<string, GuidePageFailed>;
  // Waits for the page to take in what an action did.
  readonly settle: Effect.Effect<void>;
};

// The windows, as the shell holds them.
export class GuideWindows extends Context.Service<
  GuideWindows,
  {
    // Attaches the protocol to the window's page until the scope closes.
    // Fails when the window is gone.
    readonly attach: (
      windowId: number,
    ) => Effect.Effect<GuidePage, GuideSessionEnded, Scope.Scope>;
    // Tells the window its guide changed.
    readonly tell: (
      windowId: number,
      state: GuideState | null,
    ) => Effect.Effect<void>;
  }
>()("sm/shell/GuideWindows") {}

type Session = {
  readonly token: string;
  readonly windowId: number;
  readonly harness: GuideHarness;
  readonly scope: Scope.Closeable;
  page: GuidePage | undefined;
  point: GuideState["point"];
};

export class Guide extends Context.Service<
  Guide,
  {
    // A new session for the window, replacing the one it had: its token.
    readonly start: (
      windowId: number,
      harness: GuideHarness,
    ) => Effect.Effect<string>;
    // Ends the window's session, if it has one.
    readonly end: (windowId: number) => Effect.Effect<void>;
    readonly read: (windowId: number) => Effect.Effect<GuideState | null>;
    // One action, in the window the token's session is bound to.
    readonly drive: (
      token: string,
      action: GuideAction,
    ) => Effect.Effect<
      GuideReply,
      GuideSessionEnded | GuideRefused | GuideTargetGone | GuidePageFailed
    >;
  }
>()("sm/shell/Guide") {}

// What the page says of a node: whether it is the user's alone, and
// where its middle is, scrolled into view. The point under it counts
// too, since a click lands on whatever is on top there.
const INSPECT = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (el === null) return null;
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  const hit = el.ownerDocument.elementFromPoint(x, y);
  const mine = (node) =>
    node !== null && node.closest('[data-variant$="destructive"]') !== null;
  return {
    destructive: mine(el) || mine(hit),
    terminal: el.closest(".xterm") !== null,
    x,
    y,
  };
}`;

// The same of the focused element, for a key.
const FOCUSED = `(() => {
  const el = document.activeElement;
  return {
    destructive:
      el !== null && el.closest('[data-variant$="destructive"]') !== null,
    terminal: el !== null && el.closest(".xterm") !== null,
  };
})()`;

const TARGET = "data-guide-target";

const MARK = `function () {
  for (const el of this.ownerDocument.querySelectorAll("[${TARGET}]")) {
    el.removeAttribute("${TARGET}");
  }
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (el === null) return;
  el.setAttribute("${TARGET}", "");
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}`;

const UNMARK = `for (const el of document.querySelectorAll("[${TARGET}]")) el.removeAttribute("${TARGET}");`;

const SELECT = `function () {
  if (typeof this.select === "function") return this.select();
  const range = this.ownerDocument.createRange();
  range.selectNodeContents(this);
  const selection = this.ownerDocument.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}`;

type Facts = { readonly destructive: boolean; readonly terminal: boolean };
type Spot = Facts & { readonly x: number; readonly y: number };

// What `press` sends for each key: its code, its Windows key code (which
// Chromium routes by), and the text it types.
const KEYS: Record<
  GuideKey,
  { readonly code: string; readonly keyCode: number; readonly text?: string }
> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Space: { code: "Space", keyCode: 32, text: " " },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
};

const stateOf = (session: Session): GuideState => ({
  harness: session.harness,
  point: session.point,
});

const mouse = (page: GuidePage, type: string, spot: Spot) =>
  page.send("Input.dispatchMouseEvent", {
    type,
    x: spot.x,
    y: spot.y,
    button: "left",
    clickCount: 1,
  });

const valueOf = (answer: unknown): unknown =>
  (answer as { result?: { value?: unknown } } | undefined)?.result?.value;

const make = Effect.gen(function* () {
  const windows = yield* GuideWindows;
  const sessions = yield* Ref.make<ReadonlyMap<string, Session>>(new Map());
  // One action at a time, so two never interleave their input.
  const lock = yield* Semaphore.make(1);

  const byWindow = (windowId: number) =>
    Effect.map(Ref.get(sessions), (all) =>
      [...all.values()].find((session) => session.windowId === windowId),
    );

  const close = (session: Session) =>
    Effect.gen(function* () {
      yield* Ref.update(sessions, (all) => {
        const next = new Map(all);
        next.delete(session.token);
        return next;
      });
      yield* Scope.close(session.scope, Exit.void);
    });

  const end = Effect.fn("Guide.end")(function* (windowId: number) {
    const session = yield* byWindow(windowId);
    if (session === undefined) return;
    yield* close(session);
    yield* windows.tell(windowId, null);
  });

  const start = Effect.fn("Guide.start")(function* (
    windowId: number,
    harness: GuideHarness,
  ) {
    const previous = yield* byWindow(windowId);
    if (previous !== undefined) yield* close(previous);
    const session: Session = {
      token: randomBytes(32).toString("base64url"),
      windowId,
      harness,
      scope: yield* Scope.make(),
      page: undefined,
      point: null,
    };
    yield* Ref.update(sessions, (all) =>
      new Map(all).set(session.token, session),
    );
    yield* windows.tell(windowId, stateOf(session));
    return session.token;
  });

  const read = Effect.fn("Guide.read")(function* (windowId: number) {
    const session = yield* byWindow(windowId);
    return session === undefined ? null : stateOf(session);
  });

  // The session's page, attached at its first action. Leaving the page
  // takes the mark and the protocol with it.
  const pageOf = (session: Session) =>
    Effect.gen(function* () {
      if (session.page !== undefined) return session.page;
      const page = yield* windows
        .attach(session.windowId)
        .pipe(Scope.provide(session.scope));
      yield* Scope.addFinalizer(
        session.scope,
        page
          .send("Runtime.evaluate", { expression: UNMARK })
          .pipe(Effect.ignore),
      );
      session.page = page;
      return page;
    });

  const objectOf = (page: GuidePage, ref: number) =>
    page.send("DOM.resolveNode", { backendNodeId: ref }).pipe(
      Effect.map(
        (answer) =>
          (answer as { object?: { objectId?: string } }).object?.objectId,
      ),
      Effect.orElseSucceed(() => undefined),
      Effect.filterOrFail(
        (objectId): objectId is string => objectId !== undefined,
        () => new GuideTargetGone({ ref }),
      ),
    );

  const call = (page: GuidePage, objectId: string, fn: string) =>
    Effect.map(
      page.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn,
        returnByValue: true,
      }),
      valueOf,
    );

  const spotOf = (page: GuidePage, ref: number) =>
    Effect.gen(function* () {
      const spot = (yield* call(
        page,
        yield* objectOf(page, ref),
        INSPECT,
      )) as Spot | null;
      if (spot === null) return yield* new GuideTargetGone({ ref });
      return spot;
    });

  const focused = (page: GuidePage) =>
    Effect.map(
      page.send("Runtime.evaluate", {
        expression: FOCUSED,
        returnByValue: true,
      }),
      (answer) => valueOf(answer) as Facts,
    );

  const tell = (session: Session) =>
    windows.tell(session.windowId, stateOf(session));

  const act = (session: Session, page: GuidePage, action: GuideAction) =>
    Match.valueTags(action, {
      look: () =>
        Effect.map(page.send("Accessibility.getFullAXTree"), (answer) => ({
          tree: axOutline(answer),
        })),
      screenshot: () => Effect.map(page.screenshot, (png) => ({ png })),
      navigate: ({ route }) => Effect.as(page.navigate(route), {}),
      click: ({ ref }) =>
        Effect.gen(function* () {
          const spot = yield* spotOf(page, ref);
          if (spot.destructive) {
            return yield* new GuideRefused({ reason: "destructive" });
          }
          yield* mouse(page, "mouseMoved", spot);
          yield* mouse(page, "mousePressed", spot);
          yield* mouse(page, "mouseReleased", spot);
          return {};
        }),
      fill: ({ ref, text }) =>
        Effect.gen(function* () {
          const spot = yield* spotOf(page, ref);
          if (spot.terminal) {
            return yield* new GuideRefused({ reason: "terminal" });
          }
          yield* page.send("DOM.focus", { backendNodeId: ref });
          yield* call(page, yield* objectOf(page, ref), SELECT);
          yield* text === ""
            ? page.send("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: "Backspace",
                code: "Backspace",
                windowsVirtualKeyCode: 8,
              })
            : page.send("Input.insertText", { text });
          return {};
        }),
      press: ({ key }) =>
        Effect.gen(function* () {
          const facts = yield* focused(page);
          if (facts.terminal) {
            return yield* new GuideRefused({ reason: "terminal" });
          }
          if (facts.destructive && (key === "Enter" || key === "Space")) {
            return yield* new GuideRefused({ reason: "destructive" });
          }
          const { code, keyCode, text } = KEYS[key];
          const name = key === "Space" ? " " : key;
          yield* page.send("Input.dispatchKeyEvent", {
            type: text === undefined ? "rawKeyDown" : "keyDown",
            key: name,
            code,
            windowsVirtualKeyCode: keyCode,
            ...(text === undefined ? {} : { text }),
          });
          yield* page.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: name,
            code,
            windowsVirtualKeyCode: keyCode,
          });
          return {};
        }),
      point: ({ ref, say }) =>
        Effect.gen(function* () {
          yield* call(page, yield* objectOf(page, ref), MARK);
          session.point = { say, seq: (session.point?.seq ?? 0) + 1 };
          yield* tell(session);
          return {};
        }),
      clear: () =>
        Effect.gen(function* () {
          yield* page.send("Runtime.evaluate", { expression: UNMARK });
          session.point = null;
          yield* tell(session);
          return {};
        }),
    });

  const drive = Effect.fn("Guide.drive")(function* (
    token: string,
    action: GuideAction,
  ) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const session = (yield* Ref.get(sessions)).get(token);
        if (session === undefined) return yield* new GuideSessionEnded();
        const page = yield* pageOf(session);
        const extra = yield* act(session, page, action);
        yield* page.settle;
        return { route: yield* page.route, ...extra };
      }),
    );
  });

  // A quit ends every session, detaching from its page.
  yield* Effect.addFinalizer(() =>
    Effect.flatMap(Ref.get(sessions), (all) =>
      Effect.forEach(all.values(), close, { discard: true }),
    ),
  );

  return Guide.of({ start, end, read, drive });
});

export const layer = Layer.effect(Guide, make);
