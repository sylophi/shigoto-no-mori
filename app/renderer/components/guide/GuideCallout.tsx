import { useEffect, useState } from "react";
import {
  type GuideCalloutPlace,
  GuideCalloutView,
} from "@shigomori/ui/views/guide/GuideView.tsx";
import { useGuide } from "@/hooks/useGuide";
import { useWindowRoot } from "@/lib/themeRoot";

// The element the guide points at, which its shell marks in the page
// (main/core/guide/Guide.ts).
const TARGET = "[data-guide-target]";

// The sentence's widest (the view's max-w-72), its room from the
// window's edges, and the height it is given room for under the target.
const BOX_WIDTH = 288;
const EDGE = 8;
const BOX_ROOM = 96;
const GAP = 16;

function placeOf(target: Element, root: HTMLElement): GuideCalloutPlace {
  const frame = root.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const ring = {
    x: rect.left - frame.left,
    y: rect.top - frame.top,
    width: rect.width,
    height: rect.height,
  };
  const radius = getComputedStyle(target).borderTopLeftRadius;
  const left = Math.max(EDGE, Math.min(ring.x, frame.width - BOX_WIDTH - EDGE));
  const below = ring.y + ring.height + GAP;
  return below + BOX_ROOM <= frame.height
    ? { ring, radius, left, top: below }
    : { ring, radius, left, bottom: frame.height - ring.y + GAP };
}

const samePlace = (a: GuideCalloutPlace | null, b: GuideCalloutPlace | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.ring.x === b.ring.x &&
    a.ring.y === b.ring.y &&
    a.ring.width === b.ring.width &&
    a.ring.height === b.ring.height &&
    a.radius === b.radius &&
    a.left === b.left &&
    a.top === b.top &&
    a.bottom === b.bottom);

// The ring and sentence over what the guide points at, following it as
// the page scrolls, resizes or changes under it (measured at most once a
// frame), and gone while it is off the page.
export function GuideCallout() {
  const point = useGuide()?.point ?? null;
  const root = useWindowRoot();
  const [place, setPlace] = useState<GuideCalloutPlace | null>(null);
  const seq = point?.seq;
  useEffect(() => {
    if (seq === undefined) {
      setPlace(null);
      return;
    }
    let frame = 0;
    const resized = new ResizeObserver(() => measure());
    const measure = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const target = root.querySelector(TARGET);
        if (target !== null) resized.observe(target);
        const next = target === null ? null : placeOf(target, root);
        setPlace((current) => (samePlace(current, next) ? current : next));
      });
    };
    const changed = new MutationObserver(measure);
    changed.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-guide-target"],
    });
    resized.observe(root);
    const doc = root.ownerDocument;
    doc.addEventListener("scroll", measure, true);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      changed.disconnect();
      resized.disconnect();
      doc.removeEventListener("scroll", measure, true);
    };
  }, [seq, root]);
  if (point === null || place === null) return null;
  return <GuideCalloutView place={place} say={point.say} />;
}
