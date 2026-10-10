// How the worktree footer fits a narrow pane: its verbs give up their
// labels one at a time, in LABEL_RANK order, until the row fits, and
// get them back in reverse as the pane widens. A bare icon then says
// what it is in a tooltip. The footer measures (useFittedLabels) and
// shares how far it collapsed. Each verb (FooterVerbView) hides its own
// label and turns its tooltip on.
import { type RefObject, useLayoutEffect, useState } from "react";
import { useWindowRoot } from "@/lib/themeRoot";

const rankOf = (label: HTMLElement) => Number(label.dataset.labelRank);
// A pixel of slack: the leading row shrinks to a fractional width, and
// the two widths round apart without anything visibly overflowing.
const overflows = (el: HTMLElement | null) =>
  el !== null && el.scrollWidth > el.clientWidth + 1;

// Collapses labels in rank order until nothing overflows. Two places
// can: the footer itself (its rows can't shrink), and the leading row,
// which shrinks so a note in it can truncate, and whose buttons would
// then spill over the trailing ones. The collapse itself is a DOM
// attribute set here, so every step lands in one synchronous pass
// before paint: no flicker, and each fit starts over from no collapse,
// so a wider pane gets its labels back. Re-fits when the footer
// resizes, when anything inside it changes (a verb appears once its
// query lands, a label turns into "Confirm delete?"), and when the
// labels change width without either: a font finishes loading, or the
// theme or layout on the window's root switches. Returns how far it
// collapsed, for the tooltips.
export function useFittedLabels(
  footerRef: RefObject<HTMLElement | null>,
  leadingRef: RefObject<HTMLElement | null>,
): number {
  const [through, setThrough] = useState(0);
  const root = useWindowRoot();
  useLayoutEffect(() => {
    const footer = footerRef.current;
    if (!footer) return;
    const fits = () => !overflows(footer) && !overflows(leadingRef.current);
    const fit = () => {
      // Cleared outright, not just the ranked labels: a verb that stops
      // collapsing (an armed delete) drops its rank, and would keep a
      // stale collapse.
      for (const label of footer.querySelectorAll("[data-collapsed]")) {
        label.removeAttribute("data-collapsed");
      }
      const labels = Array.from(
        footer.querySelectorAll<HTMLElement>("[data-label-rank]"),
      );
      // 0 first: nothing collapsed.
      const ranks = [0, ...new Set(labels.map(rankOf))].toSorted(
        (a, b) => a - b,
      );
      let reached = 0;
      for (const rank of ranks) {
        reached = rank;
        for (const label of labels) {
          label.toggleAttribute("data-collapsed", rankOf(label) <= rank);
        }
        if (fits()) break;
      }
      setThrough(reached);
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(footer);
    // Of the footer's attributes, only a rank: the collapse is one
    // itself, and a verb's own state (disabled, aria-pressed) doesn't
    // change its width.
    const mutation = new MutationObserver(fit);
    mutation.observe(footer, {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: ["data-label-rank"],
    });
    mutation.observe(root, {
      attributeFilter: ["class"],
    });
    document.fonts.addEventListener("loadingdone", fit);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      document.fonts.removeEventListener("loadingdone", fit);
    };
  }, [root, footerRef, leadingRef]);
  return through;
}
