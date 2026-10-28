import { useEffect, useRef, useState } from "react";
import type {
  FindBar,
  FindToggle,
} from "@shigomori/ui/views/shared/FindBarView.tsx";
import { useBinding, useKeymapAction } from "./useKeymap";

// A find bar's state, for a page that shows text (a diff, a file): the
// find keys open it, or take it back to its field, and its button
// (`toggle`) opens or closes it. The page finds the matches and draws
// the bar with their count (`bar`). Off, for a page with no text to
// find in, the keys pass and the bar stays shut. Another `subject` (the
// viewer's next file) starts again from its first match.
export function useFindBar(enabled = true, subject?: string) {
  const [opened, setOpen] = useState(false);
  const open = opened && enabled;
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(0);
  // Counts each ask to be shown a match (a step, a new query), for the
  // page to scroll to it then and not when its text changes.
  const [seek, setSeek] = useState(0);
  const ask = () => setSeek((n) => n + 1);
  const [found, setFound] = useState(subject);
  if (found !== subject) {
    setFound(subject);
    setCurrent(0);
    ask();
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const keys = useBinding("find");
  const show = () => {
    setOpen(true);
    ask();
  };
  useKeymapAction(
    "find",
    () => {
      if (!open) show();
      else {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    },
    { enabled },
  );
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // The match shown, of the `count` the page found.
  const currentOf = (count: number) =>
    Math.min(current, Math.max(count - 1, 0));
  const bar = (count: number): FindBar | null => {
    if (!open) return null;
    const at = currentOf(count);
    return {
      inputRef,
      query,
      onQuery: (next) => {
        setQuery(next);
        setCurrent(0);
        ask();
      },
      count,
      current: at,
      onStep: (by) => {
        if (count === 0) return;
        setCurrent((at + by + count) % count);
        ask();
      },
      onClose: () => setOpen(false),
    };
  };
  const toggle: FindToggle | null = enabled
    ? {
        open,
        keys: keys.label,
        onToggle: open ? () => setOpen(false) : show,
      }
    : null;
  return {
    // What the page searches for: nothing while the bar is closed. The
    // query stays for the bar's next opening.
    query: open ? query : "",
    currentOf,
    seek,
    bar,
    toggle,
  };
}
