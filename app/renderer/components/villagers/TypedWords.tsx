import { useEffect } from "react";
import { useTypedText } from "@/hooks/ui/useTypedText";

// A villager's words, typed out (useTypedText) in a box already sized for
// all of them, so nothing reflows as they come. The whole line is there
// for a screen reader from the start. An `onDone` fires once the last
// letter is out. Its own component, so only the words re-render as they
// type.
export function TypedWords({
  words,
  delayMs,
  letterMs,
  onDone,
}: {
  words: string;
  delayMs?: number;
  letterMs?: number;
  onDone?: () => void;
}) {
  const shown = useTypedText(words, { delayMs, letterMs });
  const done = shown >= words.length;
  useEffect(() => {
    if (done) onDone?.();
  }, [done, onDone]);
  return (
    <>
      {/* Kept out of a selection, which the visible copy is in. */}
      <span className="sr-only select-none">{words}</span>
      <span aria-hidden>
        {words.slice(0, shown)}
        <span className="invisible">{words.slice(shown)}</span>
      </span>
    </>
  );
}
