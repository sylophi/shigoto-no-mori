import { useEffect, useState } from "react";

// Which file the reader is currently on, for highlighting the file index.
//
// IntersectionObserver is the trigger, not the answer: no scroll handler
// runs, so nothing is measured while a 200-file patch flies past, and the
// callback only fires when a file crosses the band under the top edge.
// The answer itself comes from one geometry pass -- the first file whose
// bottom edge hasn't left the top of the view is the one being read.
// Tracking entry/exit in a Set instead looked cheaper but wasn't correct:
// when a jump parks a file's bottom edge exactly on the root edge, the
// exit notification never arrives and the highlight sticks a file behind.
//
// Targets are found in the DOM by `data-diff-file` rather than registered
// through refs, so the scroll area doesn't have to thread a callback ref
// per file. `filesKey` is the signal that the set of files changed and
// the observer has to be re-armed.
const SPY_BAND = "0px 0px -72% 0px";

// The file wrappers in scroll order. This module owns the marker, so the
// jump and step paths in DiffView read it through here rather than
// spelling the selector out again.
export function fileTargets(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-diff-file]")];
}

export function useFileScrollSpy(
  containerRef: React.RefObject<HTMLElement | null>,
  filesKey: string,
): [string | null, (key: string) => void] {
  const [activeKey, setActiveKey] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const targets = fileTargets(container);
    if (targets.length === 0) return;

    const observer = new IntersectionObserver(
      () => {
        // Reads only, so no layout thrash: the first rect forces at most
        // one flush and the rest come from the same clean layout.
        const top = container.getBoundingClientRect().top;
        for (const target of targets) {
          if (target.getBoundingClientRect().bottom <= top + 1) continue;
          const key = target.dataset["diffFile"];
          if (key !== undefined) setActiveKey(key);
          return;
        }
      },
      { root: container, rootMargin: SPY_BAND },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [containerRef, filesKey]);

  return [activeKey, setActiveKey];
}
