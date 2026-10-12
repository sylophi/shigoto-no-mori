// The guide's sessions and what they do in a window (contracts'
// modules/guide.ts). A window that asks gets a session: a token bound to
// that window alone, which `sm guide mcp` presents with every action. A
// session ends when its window stops it, asks again, or closes, and its
// token is refused from then. The window's page is driven through the
// DevTools protocol, attached at a session's first action and detached
// as it ends.
//
// Some controls are the user's alone, as the page declares them
// (`data-users-alone`, packages/ui's lib/usersAlone.ts) on the control or
// around it: one that deletes, removes or signs out, one that lets the
// account's other devices into this machine, what runs code, and the
// app's terminals. A click, a key or text on one is refused.
// A name that says it deletes is refused too, should a control go
// undeclared. The agent's server ends its session as it stops.
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
import * as Stream from "effect/Stream";
import type { CallFailure } from "@shigomori/contracts/errors";
import type {
  GuideAction,
  GuideHarness,
  GuideKey,
  GuideReply,
  GuideState,
} from "@shigomori/contracts/modules/guide";
import { USERS_ALONE } from "@shigomori/ui/lib/usersAlone.ts";
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
  { reason: Schema.Literals(["destructive", "access", "terminal"]) },
) {
  get code(): string {
    return "guide-refused";
  }

  override get message(): string {
    switch (this.reason) {
      case "destructive":
        return "That control is the user's to use: it deletes, removes, signs out or runs code. Point at it and let them decide.";
      case "access":
        return "That control lets the user's other devices into this machine, which is theirs to decide. Point at it and let them.";
      case "terminal":
        return "The app's terminals are the user's. Use your own shell instead.";
    }
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
    // Fails when the window is gone, or its page won't take it.
    readonly attach: (
      windowId: number,
    ) => Effect.Effect<
      GuidePage,
      GuideSessionEnded | GuidePageFailed,
      Scope.Scope
    >;
    // Tells the window its guide changed.
    readonly tell: (
      windowId: number,
      state: GuideState | null,
    ) => Effect.Effect<void>;
    // Opens the user's agent on a session (the host's session:guideLaunch).
    readonly launch: (input: {
      readonly session: string;
      readonly harness: GuideHarness;
    }) => Effect.Effect<void, CallFailure>;
    // Each window as it closes.
    readonly closed: Stream.Stream<number>;
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
    // Opens the harness on a new session for the window, in place of the
    // one it had. A launch that fails leaves none.
    readonly start: (
      windowId: number,
      harness: GuideHarness,
    ) => Effect.Effect<void, CallFailure>;
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

// The control a node belongs to, as the page draws it: its variant and
// its name.
const CONTROL_OF = `(node) => {
  if (node === null) return null;
  const control =
    node.closest('button, a, [role="button"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="option"], [role="tab"]') ?? node;
  const variant = control.closest("[data-variant]")?.getAttribute("data-variant") ?? "";
  const name = control.getAttribute("aria-label") ?? control.textContent ?? "";
  return { variant, name: name.trim().slice(0, 200) };
}`;

// Why the page leaves a node to the user, null when it doesn't.
const ALONE_OF = `(node) =>
  node?.closest?.("[${USERS_ALONE}]")?.getAttribute("${USERS_ALONE}") ?? null`;

// What the page says of a node: its control, the control under its
// middle (a click lands on whatever is on top there), whether either is
// the user's alone, whether it is in a terminal, and where its middle
// is, scrolled into view.
const INSPECT = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (el === null) return null;
  const controlOf = ${CONTROL_OF};
  const aloneOf = ${ALONE_OF};
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  const hit = el.ownerDocument.elementFromPoint(x, y);
  return {
    controls: [controlOf(el), controlOf(hit)].filter((c) => c !== null),
    alone: aloneOf(el) ?? aloneOf(hit),
    terminal: el.closest(".xterm") !== null,
    x,
    y,
  };
}`;

// The same of the focused element, for a key.
const FOCUSED = `(() => {
  const el = document.activeElement;
  const controlOf = ${CONTROL_OF};
  const aloneOf = ${ALONE_OF};
  const control = controlOf(el);
  return {
    controls: control === null ? [] : [control],
    alone: aloneOf(el),
    terminal: el !== null && el.closest(".xterm") !== null,
  };
})()`;

// A name that deletes, removes or signs out, for a control the page
// left undeclared.
const DESTRUCTIVE_NAME =
  /\b(delete|remove|discard|sign out|revoke|tear down|nuke|erase|wipe|drop|forget|unlink|uninstall)\b/i;

// Why a node is the user's alone, undefined when it isn't.
const aloneFor = (facts: Facts): GuideRefused["reason"] | undefined => {
  if (facts.terminal || facts.alone === "terminal") return "terminal";
  if (facts.alone === "access") return "access";
  if (
    facts.alone !== null ||
    facts.controls.some(
      ({ variant, name }) =>
        variant.endsWith("destructive") || DESTRUCTIVE_NAME.test(name),
    )
  ) {
    return "destructive";
  }
  return undefined;
};

const TARGET = "data-guide-target";

const UNMARK = `for (const el of document.querySelectorAll("[${TARGET}]")) el.removeAttribute("${TARGET}");`;

const MARK = `function () {
  ${UNMARK}
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (el === null) return;
  el.setAttribute("${TARGET}", "");
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}`;

const SELECT = `function () {
  if (typeof this.select === "function") return this.select();
  const range = this.ownerDocument.createRange();
  range.selectNodeContents(this);
  const selection = this.ownerDocument.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}`;

type Facts = {
  readonly controls: ReadonlyArray<{
    readonly variant: string;
    readonly name: string;
  }>;
  readonly alone: string | null;
  readonly terminal: boolean;
};
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

// The actions that change the page, which it takes a moment to show.
const SETTLES = new Set<GuideAction["_tag"]>([
  "navigate",
  "click",
  "fill",
  "press",
]);

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

// A key down and up, with the text it types.
const sendKey = (page: GuidePage, key: GuideKey) =>
  Effect.gen(function* () {
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
  });

const valueOf = (answer: unknown): unknown =>
  (answer as { result?: { value?: unknown } } | undefined)?.result?.value;

const make = Effect.gen(function* () {
  const windows = yield* GuideWindows;
  const sessions = yield* Ref.make<ReadonlyMap<string, Session>>(new Map());
  // One action at a time, so two never interleave their input.
  const lock = yield* Semaphore.make(1);
  // One start at a time, so a window never holds two sessions, and a
  // launch has opened or failed before the next one replaces it. Stop
  // and a window's close never wait on it: a launch can hang on macOS
  // asking whether the app may control the terminal.
  const starts = yield* Semaphore.make(1);

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

  const tell = (session: Session) =>
    windows.tell(session.windowId, stateOf(session));

  // The window hears what guides it once the session is gone: nothing,
  // or a start's that came in meanwhile (a start while the agent's
  // server ends its session, or while a launch fails).
  const endSession = (session: Session) =>
    Effect.gen(function* () {
      yield* close(session);
      const now = yield* byWindow(session.windowId);
      yield* windows.tell(
        session.windowId,
        now === undefined ? null : stateOf(now),
      );
    });

  const end = Effect.fn("Guide.end")(function* (windowId: number) {
    const session = yield* byWindow(windowId);
    if (session !== undefined) yield* endSession(session);
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
    yield* tell(session);
    yield* windows
      .launch({ session: session.token, harness })
      .pipe(Effect.onError(() => endSession(session)));
  }, starts.withPermits(1));

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
      const objectId = yield* objectOf(page, ref);
      const spot = (yield* call(page, objectId, INSPECT)) as Spot | null;
      if (spot === null) return yield* new GuideTargetGone({ ref });
      return { ...spot, objectId };
    });

  const focused = (page: GuidePage) =>
    Effect.map(
      page.send("Runtime.evaluate", {
        expression: FOCUSED,
        returnByValue: true,
      }),
      (answer) => valueOf(answer) as Facts,
    );

  const act = (
    session: Session,
    page: GuidePage,
    action: Exclude<GuideAction, { readonly _tag: "end" }>,
  ) =>
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
          const alone = aloneFor(spot);
          if (alone !== undefined)
            return yield* new GuideRefused({ reason: alone });
          yield* mouse(page, "mouseMoved", spot);
          yield* mouse(page, "mousePressed", spot);
          yield* mouse(page, "mouseReleased", spot);
          return {};
        }),
      fill: ({ ref, text }) =>
        Effect.gen(function* () {
          const spot = yield* spotOf(page, ref);
          const alone = aloneFor(spot);
          if (alone !== undefined)
            return yield* new GuideRefused({ reason: alone });
          yield* page.send("DOM.focus", { backendNodeId: ref });
          yield* call(page, spot.objectId, SELECT);
          yield* text === ""
            ? sendKey(page, "Backspace")
            : page.send("Input.insertText", { text });
          return {};
        }),
      press: ({ key }) =>
        Effect.gen(function* () {
          const facts = yield* focused(page);
          const alone = aloneFor(facts);
          // Moving off a control is the guide's, never into a terminal.
          if (
            alone === "terminal" ||
            (alone !== undefined && (key === "Enter" || key === "Space"))
          ) {
            return yield* new GuideRefused({ reason: alone });
          }
          yield* sendKey(page, key);
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
        yield* Effect.annotateCurrentSpan("action", action["_tag"]);
        if (action["_tag"] === "end") {
          yield* endSession(session);
          return { route: "" };
        }
        const page = yield* pageOf(session);
        const extra = yield* act(session, page, action);
        if (SETTLES.has(action["_tag"])) yield* page.settle;
        return { route: yield* page.route, ...extra };
      }),
    );
  });

  // A window that closes ends its session.
  yield* Effect.forkScoped(Stream.runForEach(windows.closed, end));

  // A quit ends every session, detaching from its page.
  yield* Effect.addFinalizer(() =>
    Effect.flatMap(Ref.get(sessions), (all) =>
      Effect.forEach(all.values(), close, { discard: true }),
    ),
  );

  return Guide.of({ start, end, read, drive });
});

export const layer = Layer.effect(Guide, make);
