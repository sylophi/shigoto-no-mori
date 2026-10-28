import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useFindBar } from "@/hooks/ui/useFindBar";
import {
  clearFind,
  codeLines,
  paintCurrent,
  paintMatches,
  rangesIn,
  revealRange,
  watchRenders,
} from "@/lib/find";

// The file viewer's find, for a file with text: its bar, and the
// matches in what the viewer shows, its code or its rendered Markdown.
// The viewer draws the whole file, so they're read off the page, again
// only as it draws: a step moves the match shown among those found.
export function useFileFind(
  bodyRef: RefObject<HTMLDivElement | null>,
  path: string,
  enabled: boolean,
) {
  const find = useFindBar(enabled, path);
  const { query, seek } = find;
  const found = useRef<Range[]>([]);
  const [count, setCount] = useState(0);
  // The last ask to be shown a match that was: one asked for before
  // the file is drawn is shown once it is.
  const shownSeek = useRef(seek);

  const show = useEffectEvent(() => {
    const body = bodyRef.current;
    if (!body || query === "") return;
    const shown = found.current[find.currentOf(found.current.length)];
    paintCurrent(shown ?? null);
    if (shown && shownSeek.current !== seek) {
      shownSeek.current = seek;
      revealRange(body, shown);
    }
  });
  const paint = useEffectEvent(() => {
    const body = bodyRef.current;
    if (!body) return;
    const lines = codeLines(body);
    found.current =
      lines.length > 0
        ? lines.flatMap((line) => rangesIn(line, query))
        : rangesIn(body, query);
    setCount(found.current.length);
    paintMatches(found.current);
    show();
  });
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || query === "") return;
    const stop = watchRenders(body, paint);
    return () => {
      stop();
      clearFind();
    };
  }, [bodyRef, query]);
  useEffect(() => show(), [seek]);

  return {
    bar: find.bar(query === "" ? 0 : count),
    toggle: find.toggle,
  };
}
