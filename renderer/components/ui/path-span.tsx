import type { CSSProperties } from "react";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { useShortPath } from "@/hooks/ui/useShortPath";

interface PathSpanProps {
  path: string;
  home: string | null | undefined;
  className?: string;
  style?: CSSProperties;
  title?: string;
  copyable?: boolean;
}

// Renders a path as `~/...` (tildified) and progressively abbreviates
// middle segments to a single character so it fits the element's measured
// width. The host element should be a flex child with the styles you'd
// normally apply to a truncating span (e.g. `min-w-0 truncate font-mono`)
// so the layout still bounds the box and CSS truncate acts as the floor.
//
// With `copyable`, an inline copy button (revealed on hover via `group/copy`)
// is rendered next to the text and copies the full absolute path.
export function PathSpan({
  path,
  home,
  className,
  style,
  title,
  copyable = false,
}: PathSpanProps) {
  const [ref, display] = useShortPath(path, home);
  if (copyable) {
    return (
      <span
        ref={ref}
        className={cn(
          "group/copy flex min-w-0 items-center gap-1 select-text",
          className,
        )}
        style={style}
        title={title ?? path}
      >
        <span className="min-w-0 truncate">{display}</span>
        <CopyButton value={path} label="Copy path" />
      </span>
    );
  }
  return (
    <span
      ref={ref}
      className={cn("select-text", className)}
      style={style}
      title={title ?? path}
    >
      {display}
    </span>
  );
}
