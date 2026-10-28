// The find bar's work on the page: where a query occurs, its matches
// painted through the CSS Custom Highlight API (index.css styles
// `find` and `find-current`), and the view scrolled to one. Painting
// leaves the DOM alone, so pierre's rows, which it draws again as they
// scroll, take no part in it.
import { DIFFS_TAG_NAME } from "@pierre/diffs";

// Where `query` starts in `text`, ignoring case, matches not
// overlapping.
export function occurrences(text: string, query: string): number[] {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const at: number[] = [];
  if (needle === "") return at;
  for (
    let i = haystack.indexOf(needle);
    i !== -1;
    i = haystack.indexOf(needle, i + needle.length)
  ) {
    at.push(i);
  }
  return at;
}

// The ranges `query` covers in a node's text, each of which may span
// several text nodes (a line's tokens).
export function rangesIn(root: Node, query: string): Range[] {
  const doc = root.ownerDocument ?? (root as Document);
  const segments: { node: Text; start: number }[] = [];
  let text = "";
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    segments.push({ node: textNode, start: text.length });
    text += textNode.data;
  }
  const ranges: Range[] = [];
  let i = 0;
  // Where the text's `at`th character is, searched on from the last,
  // since the matches come in order. An end lands at the end of its
  // node rather than the start of the next.
  const point = (at: number, end: boolean) => {
    for (
      let next = segments[i + 1];
      next && (end ? at > next.start : at >= next.start);
      next = segments[i + 1]
    ) {
      i++;
    }
    return segments[i];
  };
  for (const start of occurrences(text, query)) {
    const from = point(start, false);
    const to = point(start + query.length, true);
    if (!from || !to) continue;
    const range = doc.createRange();
    range.setStart(from.node, start - from.start);
    range.setEnd(to.node, start + query.length - to.start);
    ranges.push(range);
  }
  return ranges;
}

// The rows pierre has drawn in an element: a diff's file or a file
// viewer's code.
export function codeLines(root: Element): Element[] {
  const shadow = root.querySelector(DIFFS_TAG_NAME)?.shadowRoot;
  return shadow ? [...shadow.querySelectorAll("[data-line]")] : [];
}

export function paintMatches(all: Range[]): void {
  const matches = new Highlight();
  for (const range of all) matches.add(range);
  CSS.highlights.set("find", matches);
}

export function paintCurrent(range: Range | null): void {
  if (!range) {
    CSS.highlights.delete("find-current");
    return;
  }
  const current = new Highlight(range);
  current.priority = 1;
  CSS.highlights.set("find-current", current);
}

export function clearFind(): void {
  CSS.highlights.delete("find");
  CSS.highlights.delete("find-current");
}

// Runs `paint` now and again whenever what `root` shows changes,
// pierre's shadow roots included, at most once a frame. Returns the
// stop.
export function watchRenders(root: Element, paint: () => void): () => void {
  const options = { childList: true, subtree: true, characterData: true };
  const observe = () => {
    observer.observe(root, options);
    for (const host of root.querySelectorAll(DIFFS_TAG_NAME)) {
      if (host.shadowRoot) observer.observe(host.shadowRoot, options);
    }
  };
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      observe();
      paint();
    });
  });
  observe();
  paint();
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

// Scrolls `view` to a match out of its sight, a third of the way down,
// and a long line's code sideways to it.
export function revealRange(view: Element, range: Range): void {
  const box = view.getBoundingClientRect();
  let rect = range.getBoundingClientRect();
  if (rect.top < box.top || rect.bottom > box.bottom) {
    view.scrollTop += rect.top - box.top - view.clientHeight / 3;
    rect = range.getBoundingClientRect();
  }
  const code = range.startContainer.parentElement?.closest("[data-code]");
  if (!code) return;
  const sides = code.getBoundingClientRect();
  // The line numbers stay put at the left as the code scrolls under
  // them.
  const left =
    code.querySelector("[data-gutter]")?.getBoundingClientRect().right ??
    sides.left;
  if (rect.left < left || rect.right > sides.right) {
    code.scrollLeft += rect.left - (left + sides.right) / 2;
  }
}
