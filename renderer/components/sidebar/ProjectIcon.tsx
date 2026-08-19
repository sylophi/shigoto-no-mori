import type { ComponentType, SVGProps } from "react";
import { cn } from "@/lib/utils";
import { useProjectIcon } from "@/hooks/projects/useProjectIcon";

// No placeholder slot during the initial fetch -- the row simply
// tightens. Avoids the layout shift of a temporary fallback icon at the
// cost of a small one-frame shift the first time an icon resolves.
//
// `fallback` opts out of that, for lists where the icon is load-bearing
// rather than decoration: the inbox is one row per project in no
// particular grouping, so a missing icon would ripple the whole left
// edge and cost more than the shift it saves.
export function ProjectIcon({
  projectId,
  className,
  fallback: Fallback,
}: {
  projectId: string;
  className?: string;
  fallback?: ComponentType<SVGProps<SVGSVGElement>>;
}) {
  const src = useProjectIcon(projectId);
  // `className` stays last in both branches so a caller can still
  // override the defaults.
  const base = "size-3.5 shrink-0 select-none";
  if (!src) {
    if (!Fallback) return null;
    return (
      <Fallback
        aria-hidden
        className={cn(base, "text-muted-foreground/50", className)}
      />
    );
  }
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={cn(base, "rounded-sm object-contain", className)}
    />
  );
}
