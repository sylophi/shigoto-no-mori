import {
  ArrowUpDown,
  Check,
  FolderPlus,
  LayoutGrid,
  Settings as SettingsIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ProjectSortMode } from "@shared/schemas";
import { modKey, shiftKey, shortcutLabel } from "@/lib/platform";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOverlays } from "@/hooks/ui/useOverlays";
import {
  useProjectSort,
  useSetProjectSort,
} from "@/hooks/projects/useProjectSort";
import { useUpdater } from "@/hooks/system/useUpdater";

interface SidebarFooterProps {
  arrangeMode: boolean;
  onToggleArrange: () => void;
}

const SORT_OPTIONS: ReadonlyArray<{ value: ProjectSortMode; label: string }> = [
  { value: "alphabetical", label: "Alphabetical" },
  { value: "recent", label: "Most recently used" },
  { value: "frequent", label: "Most used" },
  { value: "manual", label: "Manual order" },
];

export function SidebarFooter({
  arrangeMode,
  onToggleArrange,
}: SidebarFooterProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { toggleLauncher, openAddProject } = useOverlays();
  const { data: sortMode = "manual" } = useProjectSort();
  const setSortMode = useSetProjectSort();
  const { state: updaterState } = useUpdater();
  const updateReady = updaterState?.kind === "ready";
  const settingsActive = location.pathname === "/settings";

  // Dragging only reorders coherently when the displayed order matches the
  // stored order, so arranging forces the manual sort before entering the
  // drag view.
  const arrangeManually = () => {
    setSortMode.mutate("manual");
    onToggleArrange();
  };
  if (arrangeMode) {
    return (
      <div className="flex items-center justify-end border-t border-border px-2 py-1.5">
        <button
          type="button"
          onClick={onToggleArrange}
          className="rounded-md px-2 py-1 text-[11px] font-semibold tracking-wide text-foreground uppercase transition-colors hover:bg-accent"
        >
          Done arranging
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
      <button
        type="button"
        onClick={() => void navigate({ to: "/settings" })}
        aria-label={updateReady ? "Settings (update available)" : "Settings"}
        aria-current={settingsActive ? "page" : undefined}
        title={updateReady ? "Settings — update available" : "Settings"}
        className={cn(
          "relative rounded-md p-1.5 transition-colors hover:bg-accent hover:text-foreground",
          settingsActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground",
        )}
      >
        <SettingsIcon className="size-3.5" />
        {updateReady && (
          <span
            aria-hidden
            className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-sky-500 ring-2 ring-card"
          />
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Sort projects"
              title="Sort projects"
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
            >
              <ArrowUpDown className="size-3.5" />
            </button>
          }
        />
        <DropdownMenuContent align="start" side="top" sideOffset={2}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            {SORT_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.value}
                onClick={() => setSortMode.mutate(option.value)}
              >
                <Check
                  className={cn(
                    "size-3.5",
                    sortMode === option.value ? "opacity-100" : "opacity-0",
                  )}
                />
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={arrangeManually}>
            Set manual order
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex-1" />
      <button
        type="button"
        onClick={toggleLauncher}
        aria-label="Project launcher"
        title={`Project launcher (${shortcutLabel(modKey, shiftKey, "P")})`}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <LayoutGrid className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={openAddProject}
        aria-label="Add project"
        title={`Add project (${shortcutLabel(modKey, "N")})`}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <FolderPlus className="size-3.5" />
      </button>
    </div>
  );
}
