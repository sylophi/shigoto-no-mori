import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DiffFileIndexView,
  matchingEntries,
} from "@shigomori/ui/views/diff/DiffFileIndexView.tsx";
import { usePhoneLayout } from "@/hooks/ui/useViewport";

// A row's height until it is measured: a line of text-xs and the jump
// button's padding, or a phone's touch target (phone.css).
const ROW_HEIGHT_HINT = 24;
const PHONE_ROW_HEIGHT_HINT = 44;
// The list's p-1 sets every row 4px below where the window counts it,
// so a row revealed at the bottom edge needs that much more scroll.
const LIST_PADDING = 4;

type Props = Omit<
  ComponentProps<typeof DiffFileIndexView>,
  "query" | "onQueryChange" | "listRef" | "rowWindow"
>;

// The diff's file list with only the rows near its view in the DOM. A
// changes list runs to tens of thousands of rows when a build folder or
// a node_modules isn't ignored, and a checkbox, a tooltip and two
// buttons for every one of them would hold the window for seconds and
// take gigabytes.
//
// It holds the filter, since the window is over the rows the filter
// leaves.
export function DiffFileIndex(props: Props) {
  const { entries, activeKey } = props;
  const [query, setQuery] = useState("");
  const matches = matchingEntries(entries, query);
  const listRef = useRef<HTMLDivElement>(null);
  const phone = usePhoneLayout();
  const virtualizer = useVirtualizer({
    count: matches.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => (phone ? PHONE_ROW_HEIGHT_HINT : ROW_HEIGHT_HINT),
    scrollPaddingEnd: LIST_PADDING,
    overscan: 12,
    getItemKey: (index) => matches[index]?.key ?? index,
  });

  // Keep the highlighted row on screen: past a screenful the list is
  // taller than its view, and a scroll spy's marker you can't see is no
  // marker at all. "auto" is the least scroll that shows the row, so a
  // row in view stays put and reading down a patch doesn't jitter.
  const reveal = useEffectEvent(() => {
    const index = matches.findIndex((entry) => entry.key === activeKey);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  });
  useEffect(() => {
    reveal();
  }, [activeKey]);

  return (
    <DiffFileIndexView
      {...props}
      query={query}
      onQueryChange={setQuery}
      listRef={listRef}
      rowWindow={{
        height: virtualizer.getTotalSize(),
        rows: virtualizer.getVirtualItems(),
        measureRef: virtualizer.measureElement,
      }}
    />
  );
}
