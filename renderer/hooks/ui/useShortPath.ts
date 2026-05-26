// Reactive path shortener: measure how many monospace chars fit in the
// element this hook's ref is attached to, then abbreviate the path to fit.
// The element should have `min-w-0` (so flex doesn't force it to its
// intrinsic content width) and `truncate` (as a final-floor fallback when
// even the fully-abbreviated form doesn't fit).
import { useEffect, useState } from "react";
import { tildify, tildifyAndShorten } from "@/lib/projectPaths";

const charWidthByFont = new Map<string, number>();

function measureCharWidth(font: string): number {
  const cached = charWidthByFont.get(font);
  if (cached !== undefined) return cached;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  ctx.font = font;
  const width = ctx.measureText("M").width;
  charWidthByFont.set(font, width);
  return width;
}

function fontOf(el: Element): string {
  const style = getComputedStyle(el);
  // Some browsers leave the `font` shorthand blank when not all longhands
  // were set together; rebuild from size + family in that case.
  return style.font || `${style.fontSize} ${style.fontFamily}`;
}

export function useShortPath(
  path: string,
  home: string | null | undefined,
): readonly [(el: HTMLElement | null) => void, string] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [budget, setBudget] = useState<number | null>(null);

  useEffect(() => {
    if (!el) return;
    const recompute = () => {
      const width = el.clientWidth;
      const charWidth = measureCharWidth(fontOf(el));
      if (charWidth <= 0 || width <= 0) return;
      const next = Math.max(1, Math.floor(width / charWidth));
      setBudget((prev) => (prev === next ? prev : next));
    };
    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  const display =
    budget === null
      ? tildify(path, home)
      : tildifyAndShorten(path, home, budget);
  return [setEl, display] as const;
}
