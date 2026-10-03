// The live app frames (components/LiveApp.astro): scales each window to
// its frame, poses it with the frame's clicks, and shows it once it has
// drawn. The frames are this site's own pages, so this reaches into
// them directly. Without this script a frame stays at its placeholder.

// One step of a frame's pose, run in order once the app has drawn:
// press a control, wait for something to show, or just wait. Elements
// are found by selector (see query).
export type Action =
  | { click: string }
  | { waitFor: string }
  | { waitMs: number };

// What a frame shows: the part of the window (x, y, width, height), and
// the element x and y count from, if any.
type Region = { rect: [number, number, number, number]; anchor?: string };

// Where a pin over a frame sits on the element it points at.
type Side = "top" | "bottom" | "left";

const TIMEOUT_MS = 10_000;
// How far off its element a pin sits, in the window's pixels, so it
// doesn't cover what it points at.
const PIN_GAP = 4;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function find(
  root: Document | Element,
  selector: string,
  deadline = Date.now() + TIMEOUT_MS,
): Promise<Element> {
  const found = query(root, selector);
  if (found) return found;
  if (Date.now() > deadline) throw new Error(`No ${selector} in the frame`);
  await sleep(50);
  return find(root, selector, deadline);
}

// A CSS selector, or two of Playwright's forms (the lab's shots use
// Playwright): `text=Label`, the innermost element whose text starts
// with Label, and `css:has-text("words")`, the first match of css with
// those words in it.
function query(root: Document | Element, selector: string): Element | null {
  if (selector.startsWith("text=")) {
    const label = selector.slice("text=".length);
    const starts = (el: Element) =>
      el.textContent?.trim().startsWith(label) === true;
    const first = [...root.querySelectorAll("*")].find(starts);
    let el = first;
    while (el) {
      const inner: Element | undefined = [...el.children].find(starts);
      if (!inner) return el;
      el = inner;
    }
    return null;
  }
  const hasText = /^(.*):has-text\("(.*)"\)$/.exec(selector);
  if (hasText) {
    const [, css = "*", words = ""] = hasText;
    for (const el of root.querySelectorAll(css)) {
      if (el.textContent?.includes(words)) return el;
    }
    return null;
  }
  return root.querySelector(selector);
}

// A full press, the way a pointer makes one: menus open on the down
// half, buttons act on the click. Built from the frame's own event
// classes, which its listeners expect.
function press(el: Element): void {
  const win = el.ownerDocument.defaultView;
  if (!win) return;
  for (const type of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
  ]) {
    const Event = type.startsWith("pointer")
      ? win.PointerEvent
      : win.MouseEvent;
    el.dispatchEvent(
      new Event(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: win,
        button: 0,
        buttons: type.endsWith("down") ? 1 : 0,
        pointerType: "mouse",
        isPrimary: true,
      }),
    );
  }
}

async function step(doc: Document, action: Action): Promise<void> {
  if ("click" in action) {
    const target = await find(doc, action.click);
    press(
      target.closest("button, a, [role=menuitem], [role=option]") ?? target,
    );
  } else if ("waitFor" in action) await find(doc, action.waitFor);
  else await sleep(action.waitMs);
  await sleep(150);
}

async function pose(doc: Document, actions: Action[]): Promise<void> {
  // The app has drawn once its sidebar or page is in.
  await find(doc, "#root > *");
  await sleep(300);
  for (const action of actions) {
    // oxlint-disable-next-line no-await-in-loop -- each step poses on the one before it
    await step(doc, action);
  }
}

function loaded(frame: HTMLIFrameElement): Promise<Document> {
  const doc = frame.contentDocument;
  if (doc && doc.readyState === "complete" && doc.URL !== "about:blank") {
    return Promise.resolve(doc);
  }
  return new Promise((done) =>
    frame.addEventListener(
      "load",
      () => {
        if (frame.contentDocument) done(frame.contentDocument);
      },
      { once: true },
    ),
  );
}

async function start(figure: HTMLElement): Promise<void> {
  const view = figure.querySelector<HTMLElement>(".live-view");
  const frame = figure.querySelector("iframe");
  if (!view || !frame) return;
  const region = JSON.parse(figure.dataset["region"] ?? "{}") as Region;
  const [x, y, width] = region.rect;
  let origin = { x: 0, y: 0 };

  const place = () => {
    const scale = view.clientWidth / width;
    frame.style.transform = `scale(${scale}) translate(${-(origin.x + x)}px, ${-(origin.y + y)}px)`;
  };
  new ResizeObserver(place).observe(view);

  const doc = await loaded(frame);
  const actions = JSON.parse(figure.dataset["actions"] ?? "[]") as Action[];
  await pose(doc, actions);
  const anchor = region.anchor ? await find(doc, region.anchor) : undefined;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    origin = { x: rect.left, y: rect.top };
  }
  place();

  // Pins over the frame, each on the element its selector finds inside
  // the anchor, placed in percent of the region so they scale with it.
  for (const pin of figure.querySelectorAll<HTMLElement>("[data-pin]")) {
    const target = query(anchor ?? doc, pin.dataset["pin"] ?? "");
    if (!target) continue;
    const rect = target.getBoundingClientRect();
    const side = (pin.dataset["side"] ?? "top") as Side;
    const px =
      side === "left" ? rect.left - PIN_GAP : rect.left + rect.width / 2;
    const py =
      side === "left"
        ? rect.top + rect.height / 2
        : side === "top"
          ? rect.top - PIN_GAP
          : rect.bottom + PIN_GAP;
    pin.style.setProperty("--x", `${((px - origin.x - x) / width) * 100}%`);
    pin.style.setProperty(
      "--y",
      `${((py - origin.y - y) / region.rect[3]) * 100}%`,
    );
  }
  figure.classList.add("live-ready");
}

export function startLiveFrames(): void {
  for (const figure of document.querySelectorAll<HTMLElement>("[data-live]")) {
    start(figure).catch((error: unknown) => {
      // A pose that no longer matches the app leaves the frame as it
      // drew, unposed, rather than blank.
      console.warn("[live frame]", error);
      figure.classList.add("live-ready");
    });
  }
}
