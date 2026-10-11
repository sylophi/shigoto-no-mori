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
const GAP = 12;

function placeOf(target: Element, root: HTMLElement): GuideCalloutPlace {
  const frame = root.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const ring = {
    x: rect.left - frame.left,
    y: rect.top - frame.top,
    width: rect.width,
    height: rect.height,
  };
  const left = Math.max(EDGE, Math.min(ring.x, frame.width - BOX_WIDTH - EDGE));
  const below = ring.y + ring.height + GAP;
  return below + BOX_ROOM <= frame.height
    ? { ring, left, top: below }
    : { ring, left, bottom: frame.height - ring.y + GAP };
}

const samePlace = (a: GuideCalloutPlace | null, b: GuideCalloutPlace | null) =>
  JSON.stringify(a) === JSON.stringify(b);

// The ring and sentence over what the guide points at, following it as
// the page scrolls or moves under it, and gone while it is off the page.
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
    const follow = () => {
      const target = root.querySelector(TARGET);
      const next = target === null ? null : placeOf(target, root);
      setPlace((current) => (samePlace(current, next) ? current : next));
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [seq, root]);
  if (point === null || place === null) return null;
  return <GuideCalloutView place={place} say={point.say} />;
}
