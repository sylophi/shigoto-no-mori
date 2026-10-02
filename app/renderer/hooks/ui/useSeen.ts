import { useState } from "react";

// Whether an element has come near the viewport yet, and stays true
// once it has: for a long grid whose cells each load something (the
// Visitors album's five hundred faces) so only the ones scrolled to
// load. One observer serves every element.
const MARGIN = "400px";

const callbacks = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | undefined;

function observe(element: Element, seen: () => void): () => void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        callbacks.get(entry.target)?.();
        observer?.unobserve(entry.target);
        callbacks.delete(entry.target);
      }
    },
    { rootMargin: MARGIN },
  );
  callbacks.set(element, seen);
  observer.observe(element);
  return () => {
    observer?.unobserve(element);
    callbacks.delete(element);
  };
}

export function useSeen<T extends Element>(): [
  (element: T | null) => (() => void) | undefined,
  boolean,
] {
  const [seen, setSeen] = useState(false);
  const ref = (element: T | null) => {
    if (element === null || seen) return undefined;
    return observe(element, () => setSeen(true));
  };
  return [ref, seen];
}
