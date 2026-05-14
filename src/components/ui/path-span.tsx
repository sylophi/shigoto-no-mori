import type { CSSProperties } from "react";
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
export function PathSpan({
  path,
  home,
  className,
  style,
  title,
}: PathSpanProps) {
  const [ref, display] = useShortPath(path, home);
  return (
    <span ref={ref} className={className} style={style} title={title ?? path}>
      {display}
    </span>
  );
}
