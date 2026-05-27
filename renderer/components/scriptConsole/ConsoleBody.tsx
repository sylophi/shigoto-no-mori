import { useEffect, useRef } from "react";
import { type AnserJsonEntry } from "anser";
import { Trash2 } from "lucide-react";
import { type ScriptRunState } from "@/store/scriptRuns";
import { AnsiSpan } from "./AnsiSpan";
import { findUrlRanges, parseOutput } from "./scriptConsoleAnsi";

// URLs are detected over the joined token text (not per-token) so a URL
// whose styling changes mid-string -- Vite bolds the port, npm
// underlines repo URLs, etc. -- still gets a single anchor wrapping its
// styled spans.
function renderTokens(tokens: AnserJsonEntry[]): React.ReactNode {
  const fullText = tokens.map((t) => t.content).join("");
  const urls = findUrlRanges(fullText);
  if (urls.length === 0) {
    return tokens.map((tok, i) => (
      // oxlint-disable-next-line react/no-array-index-key
      <AnsiSpan key={i} token={tok} />
    ));
  }

  let tokIdx = 0;
  let tokStart = 0;
  let key = 0;
  const emit = (from: number, to: number, sink: React.ReactNode[]) => {
    while (from < to) {
      const tok = tokens[tokIdx]!;
      const tokEnd = tokStart + tok.content.length;
      const sliceEnd = Math.min(to, tokEnd);
      const sliceTok: AnserJsonEntry = {
        ...tok,
        content: tok.content.slice(from - tokStart, sliceEnd - tokStart),
      };
      sink.push(<AnsiSpan key={key++} token={sliceTok} />);
      from = sliceEnd;
      if (from === tokEnd) {
        tokStart = tokEnd;
        tokIdx++;
      }
    }
  };

  const out: React.ReactNode[] = [];
  let pos = 0;
  for (const { start, end, url } of urls) {
    emit(pos, start, out);
    const children: React.ReactNode[] = [];
    emit(start, end, children);
    out.push(
      <a
        key={key++}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          void window.api.shell.openExternal(url);
        }}
        className="cursor-pointer underline-offset-2 hover:underline"
      >
        {children}
      </a>,
    );
    pos = end;
  }
  emit(pos, fullText.length, out);
  return out;
}

export function ConsoleBody({
  state,
  onClear,
}: {
  state: ScriptRunState;
  onClear: (() => void) | null;
}) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const stickRef = useRef(true);

  const tokens = parseOutput(state.output);
  const rendered = renderTokens(tokens);

  // Honor the user's scroll position: only auto-scroll if they're
  // already pinned near the bottom.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distance < 24;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [tokens]);

  if (state.status === "idle" && tokens.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        No runs yet. Press Run to start.
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 bg-background">
      <pre
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full w-full overflow-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground select-text"
      >
        {tokens.length === 0 ? "Starting…" : rendered}
      </pre>
      {onClear && (
        <button
          type="button"
          onClick={onClear}
          aria-label="Clear log"
          title="Clear log"
          className="absolute top-2 right-3 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}
