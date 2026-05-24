import { cn } from "@/lib/utils";
import { useProjectIcon } from "@/hooks/projects/useProjectIcon";

// No placeholder slot during the initial fetch — the row simply
// tightens. Avoids the layout shift of a temporary fallback icon at the
// cost of a small one-frame shift the first time an icon resolves.
export function ProjectIcon({
  projectId,
  className,
}: {
  projectId: string;
  className?: string;
}) {
  const src = useProjectIcon(projectId);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className={cn(
        "size-3.5 shrink-0 select-none rounded-sm object-contain",
        className,
      )}
    />
  );
}
