import { useEffect, useState } from "react";

// How much of `text` is out so far, a letter every `letterMs` after
// `delayMs`, the way a villager's dialogue box fills in (or a letter
// writes itself), or all of it at once under reduced motion. For a text
// that stays put: a new one wants a new component.
export function useTypedText(
  text: string,
  { delayMs = 0, letterMs = 28 }: { delayMs?: number; letterMs?: number } = {},
): number {
  const [shown, setShown] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? text.length
      : 0,
  );
  useEffect(() => {
    if (shown >= text.length) return;
    const timer = setTimeout(
      () => setShown(shown + 1),
      shown === 0 ? delayMs + letterMs : letterMs,
    );
    return () => clearTimeout(timer);
  }, [shown, text.length, delayMs, letterMs]);
  return shown;
}
