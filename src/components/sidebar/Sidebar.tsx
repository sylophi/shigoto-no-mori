import { FolderPlus, Search, Settings as SettingsIcon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
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
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 px-2 pt-0 pb-2">
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
      <SidebarFooter />
    </aside>
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
        onClick={() => openIn("add-project")}
        aria-label="Add project"
        title="Add project (⌘N)"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <FolderPlus className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => openIn("browse")}
        aria-label="Command palette"
        title="Command palette (⌘T)"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="size-3.5" />
      </button>
      <div className="flex-1" />
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
    </div>
  );
}
