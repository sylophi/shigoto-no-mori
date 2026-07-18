import { useProjectIcon } from "@/hooks/projects/useProjectIcon";
import { cn } from "@/lib/utils";
import type { Project } from "@shared/schemas";

interface LauncherTileProps {
  project: Project;
  selected: boolean;
  onActivate: (project: Project) => void;
}

export function LauncherTile({
  project,
  selected,
  onActivate,
}: LauncherTileProps) {
  const iconSrc = useProjectIcon(project.id);
  // useProjectIcon returns null for icon-less projects; a monogram keeps
  // the tile legible instead of a blank plate.
  const monogram = (project.name[0] ?? "?").toUpperCase();
  const missing = project.pathExists === false;

  return (
    <button
      type="button"
      role="option"
      id={`launcher-tile-${project.id}`}
      data-slot="launcher-tile"
      aria-selected={selected}
      onClick={() => onActivate(project)}
      title={missing ? `${project.path} is missing` : project.path}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-lg p-2 text-center outline-none transition-colors",
        "hover:bg-accent/60 aria-selected:bg-accent aria-selected:text-accent-foreground",
        missing && "opacity-50",
      )}
    >
      <span className="flex size-12 items-center justify-center overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {iconSrc ? (
          <img
            src={iconSrc}
            alt=""
            draggable={false}
            className="size-8 rounded-md object-contain"
          />
        ) : (
          <span className="text-lg font-semibold text-muted-foreground">
            {monogram}
          </span>
        )}
      </span>
      <span className="w-full truncate text-xs font-medium">
        {project.name}
      </span>
    </button>
  );
}
