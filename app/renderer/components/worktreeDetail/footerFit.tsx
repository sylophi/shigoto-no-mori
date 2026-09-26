// How the worktree footer fits a narrow pane: its verbs give up their
// labels one at a time, in LABEL_RANK order, until the row fits, and
// get them back in reverse as the pane widens. A bare icon then says
// what it is in a tooltip. The footer measures (useFittedLabels) and
// shares how far it collapsed. Each verb (FooterVerb) hides its own
// label and turns its tooltip on.
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";

// First to lose its label, first. The long, rarely used transfers go
// first. The verbs whose label carries state (a running mirror's peer,
// auto-pull on or off) or guards a delete go last.
export const LABEL_RANK = {
  transplant: 1,
  mirrorTo: 2,
  ports: 3,
  files: 4,
  mirror: 5,
  shelve: 6,
  autoPull: 7,
  delete: 8,
} as const;

const rankOf = (label: HTMLElement) => Number(label.dataset.labelRank);
// A pixel of slack: the leading row shrinks to a fractional width, and
// the two widths round apart without anything visibly overflowing.
const overflows = (el: HTMLElement | null) =>
  el !== null && el.scrollWidth > el.clientWidth + 1;

// Every label ranked at or below this is collapsed. 0: none.
const CollapsedThrough = createContext(0);
export const CollapsedThroughProvider = CollapsedThrough.Provider;

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
// theme or layout on <html> switches. Returns how far it collapsed,
// for the tooltips.
export function useFittedLabels(
  footerRef: RefObject<HTMLElement | null>,
  leadingRef: RefObject<HTMLElement | null>,
): number {
  const [through, setThrough] = useState(0);
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
    mutation.observe(document.documentElement, {
      attributeFilter: ["class", "data-layout"],
    });
    document.fonts.addEventListener("loadingdone", fit);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      document.fonts.removeEventListener("loadingdone", fit);
    };
  }, [footerRef, leadingRef]);
  return through;
}

// A footer verb: an icon and a label that can collapse. Collapsed, the
// label stays for screen readers (sr-only) and shows as a tooltip. The
// title, a longer hint, gives way to it so two don't stack. A disabled
// button gets no pointer events and so no tooltip, so there the title
// stays and names the verb. No rank: the label never collapses (an
// armed delete asking for its second click).
export function FooterVerb({
  rank,
  icon,
  label,
  title,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "title"> & {
  rank: number | undefined;
  icon: ReactNode;
  label: string;
  title?: string;
}) {
  const through = useContext(CollapsedThrough);
  const collapsed = rank !== undefined && rank <= through;
  let hint = title;
  if (collapsed) {
    hint = disabled ? (title ? `${label}: ${title}` : label) : undefined;
  }
  return (
    <SimpleTooltip tip={label} disabled={!collapsed || disabled}>
      <Button size="xs" disabled={disabled} title={hint} {...props}>
        {icon}
        <span data-label-rank={rank} className="data-collapsed:sr-only">
          {label}
        </span>
      </Button>
    </SimpleTooltip>
  );
}
