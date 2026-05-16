import { useEffect, useRef, useState } from "react";
import {
  FolderPlus,
  Loader2,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useIsFetching } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useProjects } from "@/hooks/useProjects";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProjectGroup } from "./ProjectGroup";

export function Sidebar() {
  const { data: projects = [], isLoading } = useProjects();

  return (
    <aside className="flex h-full flex-col bg-card">
      <SidebarHeader />
      <div className="relative min-h-0 flex-1">
        <ScrollArea className="size-full">
          {/* Small pb keeps the activity-indicator overlay from sitting
              flush on top of the last project row when scrolled all the
              way down. */}
          <div className="flex flex-col gap-1 px-2 pt-0 pb-3">
            {projects.map((project) => (
              <ProjectGroup key={project.id} project={project} />
            ))}
            {!isLoading && projects.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                No projects yet.
              </div>
            )}
          </div>
        </ScrollArea>
        <ActivityIndicator />
      </div>
      <SidebarFooter />
    </aside>
  );
}

const SPINNER_LINGER_MS = 100;

function ActivityIndicator() {
  // Queries with `meta: { silentSpinner: true }` show their own
  // inline loaders and don't count toward this global indicator.
  const fetching = useIsFetching({
    predicate: (q) => !q.meta?.silentSpinner,
  });
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fetching > 0) {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
      setVisible(true);
      return;
    }
    // Without a brief linger the indicator would never become
    // perceptible: local git calls finish in tens of milliseconds.
    hideTimer.current = setTimeout(() => {
      setVisible(false);
      hideTimer.current = null;
    }, SPINNER_LINGER_MS);
    return () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };
  }, [fetching]);

  return (
    <div
      aria-hidden={!visible}
      aria-label={visible ? "Syncing with git" : undefined}
      className={cn(
        // Anchored to the scroll-area wrapper (not the aside), so it
        // floats over the bottom-left of the visible viewport
        // regardless of how far the project list has scrolled.
        "pointer-events-none absolute bottom-3 left-3 text-muted-foreground/60 transition-opacity",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <Loader2 className="size-3.5 animate-spin" />
    </div>
  );
}

function SidebarHeader() {
  return (
    <div
      className="flex h-[52px] items-center px-3 pl-[92px]"
      // macOS title-bar drag region
      style={{ ["-webkit-app-region" as never]: "drag" }}
    >
      <div className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight">
        Shigoto no Mori
      </div>
    </div>
  );
}

function SidebarFooter() {
  const navigate = useNavigate();
  const location = useLocation();
  const { openIn } = useCommandPalette();
  const settingsActive = location.pathname === "/settings";
  return (
    <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
      <button
        type="button"
        onClick={() => void navigate({ to: "/settings" })}
        aria-label="Settings"
        aria-current={settingsActive ? "page" : undefined}
        title="Settings"
        className={cn(
          "rounded-md p-1.5 transition-colors hover:bg-accent hover:text-foreground",
          settingsActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground",
        )}
      >
        <SettingsIcon className="size-3.5" />
      </button>
      <div className="flex-1" />
      <button
        type="button"
        onClick={() => openIn("browse")}
        aria-label="Command palette"
        title="Command palette (⌘T)"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => openIn("add-project")}
        aria-label="Add project"
        title="Add project (⌘N)"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <FolderPlus className="size-3.5" />
      </button>
    </div>
  );
}
