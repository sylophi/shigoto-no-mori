import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";
import { measureElement, useVirtualizer } from "@tanstack/react-virtual";
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  DiffFileSlotView,
  DiffPaneView,
  estimateFileHeight,
  FILE_GAP,
  type DiffStyle,
} from "@shigomori/ui/views/diff/DiffPageView.tsx";
import { fileKey } from "@shigomori/ui/lib/patchFiles.ts";

// Files drawn past either edge of the view, so a short scroll lands on
// files already drawn.
const OVERSCAN = 4;

type Props = Omit<
  ComponentProps<typeof DiffPaneView>,
  "scrollRef" | "height" | "children"
> & {
  scrollRef: RefObject<HTMLDivElement | null>;
  files: readonly FileDiffMetadata[];
  // Each file's row (DiffFileRowView), in the files' order. Made once
  // per patch and layout by the caller, so a scroll hands the files it
  // keeps the same elements and they don't draw again.
  rows: readonly ReactNode[];
  collapsedKeys: ReadonlySet<string>;
  diffStyle: DiffStyle;
  wrapLines: boolean;
  // A file to put at the top of the view, anew each time it's asked.
  jump: { key: string } | null;
  // Told which file is being read as the scroll reaches it. Absent for
  // a pane of the one file it was asked for.
  onRead?: (key: string) => void;
};

// The patch's files with only those near the view mounted. A FileDiff
// measures where it sits as it mounts, so thousands of files laid out
// whole force a layout for each in turn before the window can paint,
// and each is drawn and highlighted. The others are placed by their
// estimated heights until they're drawn.
//
// It owns the virtualizer and only that: useVirtualizer opts its
// component out of React Compiler memoization and re-renders it as the
// files in view change, which here only places a few slots again.
export function DiffPane({
  scrollRef,
  files,
  rows,
  collapsedKeys,
  diffStyle,
  wrapLines,
  jump,
  onRead,
  ...pane
}: Props) {
  // A file's size is kept for the layout it was measured in, so a fold,
  // a switch to split or wrapping doesn't place it at a size it no
  // longer has.
  const layout = `${diffStyle}:${wrapLines}`;
  const estimate = (index: number) => {
    const file = files[index];
    return file
      ? estimateFileHeight(file, {
          collapsed: collapsedKeys.has(fileKey(file)),
          diffStyle,
        })
      : 0;
  };
  const fileWindow = useVirtualizer({
    count: pane.state === "files" ? files.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimate,
    // A file mounts empty and pierre draws it a frame later. Until then
    // it keeps its estimate, or the window would take it for no height
    // and mount as many files as a screen holds of those. Drawn, it is
    // never empty: its header alone has a height.
    measureElement: (element, entry, instance) =>
      measureElement(element, entry, instance) ||
      estimate(instance.indexFromElement(element)),
    getItemKey: (index) => {
      const file = files[index];
      if (!file) return index;
      const key = fileKey(file);
      return `${layout}:${collapsedKeys.has(key)}:${key}`;
    },
    paddingStart: FILE_GAP,
    paddingEnd: FILE_GAP,
    gap: FILE_GAP,
    // A jump leaves the gap above the file that scrolling to its top
    // would.
    scrollPaddingStart: FILE_GAP,
    overscan: OVERSCAN,
  });
  // A file that grows as its rows are drawn (wrapped lines, the changes
  // page's hunk bars) keeps the lines in view where they are by itself,
  // pierre's Virtualizer doing it, so the window moves the scroll only
  // for a file wholly above the view.
  fileWindow.shouldAdjustScrollPositionOnItemSizeChange = (
    item,
    _delta,
    instance,
  ) => item.end <= (instance.scrollOffset ?? 0);

  // Where the reader is, kept as the view scrolls: the file being read
  // and how far into it the view is. A new layout or fold places every
  // file anew, by sizes the files above haven't been drawn at, and the
  // view goes back to the same place in the same file, or to its top
  // as a jump lands when it's now shorter than that.
  const place = useRef<{ index: number; into: number }>(undefined);
  useEffect(() => {
    const view = scrollRef.current;
    if (!view) return;
    const keep = () => {
      const item = fileWindow.getVirtualItemForOffset(
        view.scrollTop + FILE_GAP + 1,
      );
      place.current = item && {
        index: item.index,
        into: view.scrollTop - item.start,
      };
    };
    view.addEventListener("scroll", keep, { passive: true });
    return () => view.removeEventListener("scroll", keep);
  }, [scrollRef, fileWindow]);
  const returnToPlace = useEffectEvent(() => {
    const was = place.current;
    const item = was && fileWindow.measurementsCache[was.index];
    if (!item) return;
    const to =
      was.into < item.size ? item.start + was.into : item.start - FILE_GAP;
    fileWindow.scrollToOffset(to);
    // The window reads the view's offset back only when the scroll
    // event comes. Until then the files measured below (remeasure) are
    // placed against this one, not the offset left behind.
    fileWindow.scrollOffset = to;
  });
  useLayoutEffect(() => {
    returnToPlace();
  }, [layout, collapsedKeys]);

  // The files on screen are measured again for a new layout: one whose
  // size it didn't change gets no resize to be measured by, and would
  // stay at its estimate.
  const remeasure = useEffectEvent(() => {
    for (const node of fileWindow.elementsCache.values())
      if (node.isConnected) fileWindow.measureElement(node);
  });
  useLayoutEffect(() => {
    remeasure();
  }, [layout]);

  const jumpTo = useEffectEvent((key: string) => {
    const index = files.findIndex((file) => fileKey(file) === key);
    if (index >= 0) fileWindow.scrollToIndex(index, { align: "start" });
  });
  useEffect(() => {
    if (jump) jumpTo(jump.key);
  }, [jump]);

  // The file being read: the first whose bottom is more than a pixel
  // under the top of the view, read off where the files sit. The next
  // file starts a gap below a file's bottom.
  const reading = fileWindow.getVirtualItemForOffset(
    (fileWindow.scrollOffset ?? 0) + FILE_GAP + 1,
  );
  const readFile = reading && files[reading.index];
  const readKey = readFile ? fileKey(readFile) : undefined;
  const read = useEffectEvent((key: string) => onRead?.(key));
  useEffect(() => {
    if (readKey !== undefined) read(readKey);
  }, [readKey]);

  return (
    <DiffPaneView
      {...pane}
      scrollRef={scrollRef}
      height={fileWindow.getTotalSize()}
    >
      {fileWindow.getVirtualItems().map((item) => {
        const file = files[item.index];
        return (
          file && (
            <DiffFileSlotView
              key={fileKey(file)}
              index={item.index}
              start={item.start}
              measureRef={fileWindow.measureElement}
            >
              {rows[item.index]}
            </DiffFileSlotView>
          )
        );
      })}
    </DiffPaneView>
  );
}
