import {
  ArrowUpDown,
  FolderPlus,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { useCommandPalette } from "@/hooks/ui/useCommandPalette";
import { useUpdater } from "@/hooks/system/useUpdater";

interface SidebarFooterProps {
  arrangeMode: boolean;
  onToggleArrange: () => void;
}

export function SidebarFooter({
  arrangeMode,
  onToggleArrange,
}: SidebarFooterProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { openIn } = useCommandPalette();
  const { state: updaterState } = useUpdater();
  const updateReady = updaterState?.kind === "ready";
  const settingsActive = location.pathname === "/settings";
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
      <button
        type="button"
        onClick={onToggleArrange}
        aria-label="Arrange projects"
        title="Arrange projects"
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowUpDown className="size-3.5" />
      </button>
      <div className="flex-1" />
      <button
        type="button"
        onClick={() => openIn("browse")}
        aria-label="Command palette"
        title="Command palette (⌘⇧P)"
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
