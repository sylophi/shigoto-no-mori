import { useEffect, useRef } from "react";

// A drawer's tabs, once per mount: the first count (undefined until
// the terminals are read) with no tab at all opens a terminal, once
// there is somewhere to open it, and no tab left after some were there
// is the last one closing.
export function useOpenWhenEmpty(
  count: number | undefined,
  open: (() => void) | undefined,
  onEmpty: () => void,
): void {
  const seen = useRef<"waiting" | "opened" | "had">("waiting");
  useEffect(() => {
    if (count === undefined) return;
    if (count > 0) {
      seen.current = "had";
      return;
    }
    if (seen.current === "waiting" && open !== undefined) {
      seen.current = "opened";
      open();
    } else if (seen.current === "had") {
      onEmpty();
    }
  });
}
