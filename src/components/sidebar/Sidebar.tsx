import { FolderPlus, Moon, Sun, SunMoon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { useTheme } from "@/hooks/useTheme";
import { useProjects } from "@/hooks/useProjects";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProjectGroup } from "./ProjectGroup";

export function Sidebar() {
  const { data: projects = [], isLoading } = useProjects();

  return (
    <aside className="flex h-full flex-col border-r border-border bg-card">
      <SidebarHeader />
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 px-2 py-2">
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
  const { openIn } = useCommandPalette();

  return (
    <div
      className="flex h-11 items-center gap-2 px-3"
      // macOS title-bar drag region
      style={{ ["-webkit-app-region" as never]: "drag" }}
    >
      <div className="flex flex-1 items-center pl-16 text-[13px] font-semibold tracking-tight">
        Shigoto no Mori
      </div>
      <button
        type="button"
        onClick={() => openIn("add-project")}
        // Opt out of the title-bar drag region so the click is captured.
        style={{ ["-webkit-app-region" as never]: "no-drag" }}
        className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Add project"
        title="Add project (⌘K)"
      >
        <FolderPlus className="size-3.5" />
      </button>
    </div>
  );
}

function SidebarFooter() {
  return (
    <div className="flex items-center justify-end gap-1 border-t border-border px-2 py-1.5">
      <ThemeToggle />
    </div>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next: Record<typeof theme, typeof theme> = {
    light: "dark",
    dark: "system",
    system: "light",
  };
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : SunMoon;
  return (
    <button
      type="button"
      onClick={() => setTheme(next[theme])}
      className={cn(
        "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
      )}
      aria-label={`Theme: ${theme} (click to change)`}
      title={`Theme: ${theme}`}
    >
      <Icon className="size-3.5" />
    </button>
  );
}
