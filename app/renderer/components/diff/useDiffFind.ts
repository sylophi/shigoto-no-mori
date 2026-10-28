import { useEffect, useEffectEvent, type RefObject } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { DiffStyle } from "@shigomori/ui/views/diff/DiffPageView.tsx";
import { CODE_LINE_HEIGHT } from "@shigomori/ui/views/diff/codeTheme.ts";
import { fileKey } from "@shigomori/ui/lib/patchFiles.ts";
import { useFindBar } from "@/hooks/ui/useFindBar";
import {
  clearFind,
  codeLines,
  occurrences,
  paintCurrent,
  paintMatches,
  rangesIn,
  revealRange,
  watchRenders,
} from "@/lib/find";

// A match in a patch: its file, its row as pierre numbers it in each
// layout (a row's `data-line-index`), and which of the row's matches
// it is.
interface DiffMatch {
  readonly key: string;
  readonly unified: number;
  readonly split: number;
  readonly nth: number;
}

// Every match in the patch's text, in the order a unified diff reads.
// Read off the patch rather than the page: the page draws only the
// rows near the view.
function diffMatches(
  files: readonly FileDiffMetadata[],
  query: string,
): DiffMatch[] {
  const matches: DiffMatch[] = [];
  if (query === "") return matches;
  for (const file of files) {
    const key = fileKey(file);
    // `count` lines of one side from `at`, on the rows from `unified`
    // and `split`.
    const rows = (
      lines: readonly string[],
      at: number,
      count: number,
      unified: number,
      split: number,
    ) => {
      for (let i = 0; i < count; i++) {
        occurrences(lines[at + i] ?? "", query).forEach((_, nth) =>
          matches.push({ key, unified: unified + i, split: split + i, nth }),
        );
      }
    };
    for (const hunk of file.hunks) {
      let unified = hunk.unifiedLineStart;
      let split = hunk.splitLineStart;
      for (const content of hunk.hunkContent) {
        if (content.type === "context") {
          rows(
            file.additionLines,
            content.additionLineIndex,
            content.lines,
            unified,
            split,
          );
          unified += content.lines;
          split += content.lines;
        } else {
          // Unified, a change reads its deletions, then its additions.
          // Split, the two sides share rows.
          rows(
            file.deletionLines,
            content.deletionLineIndex,
            content.deletions,
            unified,
            split,
          );
          rows(
            file.additionLines,
            content.additionLineIndex,
            content.additions,
            unified + content.deletions,
            split,
          );
          unified += content.deletions + content.additions;
          split += Math.max(content.deletions, content.additions);
        }
      }
    }
  }
  return matches;
}

const fileSlot = (view: Element, key: string) =>
  [...view.querySelectorAll("[data-diff-file]")].find(
    (slot) => slot.getAttribute("data-diff-file") === key,
  );

const rowIndex = (line: Element, diffStyle: DiffStyle) =>
  Number(
    line.getAttribute("data-line-index")?.split(",")[
      diffStyle === "split" ? 1 : 0
    ],
  );

// The row a match is on, among a file's drawn rows. A context row
// shows on both sides of a split diff: the first is the one.
const rowOf = (lines: Element[], match: DiffMatch) =>
  lines.find((line) => rowIndex(line, "unified") === match.unified);

const REVEAL_FRAMES = 60;

// Takes the view to a match, frame by frame until its row is drawn.
// Returns the stop.
function revealMatch(
  view: Element,
  match: DiffMatch,
  {
    query,
    diffStyle,
    toFile,
  }: { query: string; diffStyle: DiffStyle; toFile: (key: string) => void },
): () => void {
  let frames = 0;
  let frame = 0;
  const step = () => {
    frames += 1;
    if (frames > REVEAL_FRAMES) return;
    const slot = fileSlot(view, match.key);
    const lines = slot ? codeLines(slot) : [];
    if (lines.length === 0) {
      if (frames === 1) toFile(match.key);
      frame = requestAnimationFrame(step);
      return;
    }
    const row = rowOf(lines, match);
    const range = row && rangesIn(row, query)[match.nth];
    if (range) {
      revealRange(view, range);
      return;
    }
    // Toward it from the drawn row nearest it, by the rows between.
    const target = diffStyle === "split" ? match.split : match.unified;
    const nearest = lines.reduce((best, line) =>
      Math.abs(rowIndex(line, diffStyle) - target) <
      Math.abs(rowIndex(best, diffStyle) - target)
        ? line
        : best,
    );
    view.scrollTop +=
      nearest.getBoundingClientRect().top -
      view.getBoundingClientRect().top -
      view.clientHeight / 3 +
      (target - rowIndex(nearest, diffStyle)) * CODE_LINE_HEIGHT;
    frame = requestAnimationFrame(step);
  };
  step();
  return () => cancelAnimationFrame(frame);
}

// The diff page's find: its bar, every match in the patch counted and
// those drawn painted, and the view taken to the one shown. That row
// may not be drawn: its file not mounted (DiffPane), or folded, or the
// row outside the window pierre draws of a long file. So the view goes
// to the file (`toFile`), then on by the rows between the nearest one
// drawn and it, until it is drawn.
export function useDiffFind({
  scrollRef,
  files,
  diffStyle,
  toFile,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  files: readonly FileDiffMetadata[];
  diffStyle: DiffStyle;
  // Unfolds a file and puts it at the top of the view.
  toFile: (key: string) => void;
}) {
  const find = useFindBar();
  const { query, seek } = find;
  const matches = diffMatches(files, query);
  const current = matches[find.currentOf(matches.length)];

  const paint = useEffectEvent(() => {
    const view = scrollRef.current;
    if (!view) return;
    const all: Range[] = [];
    let shown: Range | null = null;
    for (const slot of view.querySelectorAll("[data-diff-file]")) {
      const lines = codeLines(slot);
      const own =
        current && slot.getAttribute("data-diff-file") === current.key;
      const row = own ? rowOf(lines, current) : undefined;
      for (const line of lines) {
        const ranges = rangesIn(line, query);
        all.push(...ranges);
        if (current && line === row) shown = ranges[current.nth] ?? null;
      }
    }
    paintMatches(all);
    paintCurrent(shown);
  });
  useEffect(() => {
    const view = scrollRef.current;
    if (!view || query === "") return;
    const stop = watchRenders(view, paint);
    return () => {
      stop();
      clearFind();
    };
  }, [scrollRef, query]);
  // A new patch or layout, or another match shown, repaints what's
  // drawn.
  useEffect(() => {
    paint();
  }, [current, matches.length, diffStyle]);

  // Only an ask to be shown a match moves the view: not the patch
  // changing under it.
  const reveal = useEffectEvent(() => {
    const view = scrollRef.current;
    if (!view || !current) return;
    return revealMatch(view, current, { query, diffStyle, toFile });
  });
  useEffect(() => reveal(), [seek]);

  return { bar: find.bar(matches.length), toggle: find.toggle };
}
