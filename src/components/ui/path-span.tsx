import type { ClipboardEvent, CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { useShortPath } from "@/hooks/useShortPath";

interface PathSpanProps {
  path: string;
  home: string | null | undefined;
  className?: string;
  style?: CSSProperties;
  title?: string;
}

// Renders a path as `~/...` (tildified) and progressively abbreviates
// middle segments to a single character so it fits the element's measured
// width. The host element should be a flex child with the styles you'd
// normally apply to a truncating span (e.g. `min-w-0 truncate font-mono`)
// so the layout still bounds the box and CSS truncate acts as the floor.
//
// Selection is enabled and copy yields the full absolute path, not the
// abbreviated rendering, so pasting into a terminal works.
export function PathSpan({
  path,
  home,
  className,
  style,
  title,
}: PathSpanProps) {
  const [ref, display] = useShortPath(path, home);
  const handleCopy = (e: ClipboardEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.clipboardData.setData("text/plain", path);
  };
  return (
    <span
      ref={ref}
      className={cn("select-text", className)}
      style={style}
      title={title ?? path}
      onCopy={handleCopy}
    >
      {display}
    </span>
  );
}
