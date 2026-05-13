import { Moon, Plus, Sun, SunMoon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { ScrollArea } from "@/components/ui/scroll-area";
import { mockProjects } from "@/lib/mockData";
import { ProjectGroup } from "./ProjectGroup";

export function Sidebar() {
  return (
    <aside className="flex h-full flex-col border-r border-border bg-card">
      <SidebarHeader />
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 px-2 py-2">
          {mockProjects.map((project) => (
            <ProjectGroup key={project.id} project={project} />
          ))}
        </div>
      </ScrollArea>
      <SidebarFooter />
    </aside>
  );
}

function SidebarHeader() {
  return (
    <div
      className="flex h-11 items-center px-3"
      // macOS title-bar drag region
      style={{ ["-webkit-app-region" as never]: "drag" }}
    >
      <div className="flex w-full items-center pl-16 text-[13px] font-semibold tracking-tight">
        Shigoto no Mori
      </div>
    </div>
  );
}

function SidebarFooter() {
  return (
    <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
      <button
        type="button"
        className="flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-3.5" />
        <span>Add project</span>
      </button>
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
