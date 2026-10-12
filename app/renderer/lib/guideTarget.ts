// The control the guide points at, found again when a re-render replaces
// its element and takes the shell's mark (`data-guide-target`,
// main/core/guide/Guide.ts) with it: a row the agent clicks re-renders as
// the page moves under it. GuideCallout.tsx keeps the key of what it
// last followed and marks the replacement.

export const GUIDE_TARGET = "data-guide-target";

// What an element is read by here, which a DOM element and a proof's fake
// both are.
export interface TargetLike {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  readonly ownerDocument: {
    getElementById(id: string): { readonly textContent: string | null } | null;
  };
}

// The attributes that name a control and stay the same through a
// re-render. Not an id or aria-labelledby's ids, which a remount draws
// anew: what those ids label it with is read instead.
const NAMING = ["role", "aria-label", "href", "name"] as const;

const collapsed = (text: string | null) =>
  (text ?? "").replace(/\s+/g, " ").trim();

// Which control an element is: its tag, the attributes that name it, the
// text of what labels it, and its own text, which a re-render of the same
// control draws again. Two switches named only by their labels differ by
// those.
export function targetKey(el: TargetLike): string {
  return [
    el.tagName,
    ...NAMING.map((name) => el.getAttribute(name) ?? ""),
    collapsed(
      (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" "),
    ),
    collapsed(el.textContent),
  ].join("\u0000");
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export const centerOf = (el: TargetLike): Point => {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};

// The element under `root` that is the control `key` names, or null
// when the page no longer has it. Of two that are (two rows of one
// name), the one nearest where the last one stood.
export function refindTarget<E extends TargetLike>(
  root: { querySelectorAll(selectors: string): Iterable<E> },
  key: string,
  near: Point,
): E | null {
  const tag = key.slice(0, key.indexOf("\u0000"));
  let best: E | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const el of root.querySelectorAll(tag)) {
    if (targetKey(el) !== key) continue;
    const at = centerOf(el);
    const distance = Math.hypot(at.x - near.x, at.y - near.y);
    if (distance < bestDistance) {
      best = el;
      bestDistance = distance;
    }
  }
  return best;
}
