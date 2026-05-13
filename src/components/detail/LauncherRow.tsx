import { ChevronDown, Code, Sparkles, Terminal, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  useLaunch,
  useLauncherForProject,
  useSetPreferredLauncher,
} from "@/hooks/useLaunchers";
import { cn } from "@/lib/utils";
import type { LauncherEntry, Worktree } from "@shared/schemas";

interface LauncherRowProps {
  worktree: Worktree;
}

// Map lucide icon names from the main-process catalog to actual components.
// Anything not in this map falls back to a generic icon.
const ICON_MAP: Record<string, typeof Code> = {
  code: Code,
  "cursor-text": Sparkles,
  zap: Zap,
  "file-code": Code,
  "square-code": Code,
  terminal: Terminal,
  "terminal-square": Terminal,
  "square-terminal": Terminal,
  folder: Code,
};

function IconFor({ name }: { name: string }) {
  const Icon = ICON_MAP[name] ?? Code;
  return <Icon className="size-3.5" />;
}

export function LauncherRow({ worktree }: LauncherRowProps) {
  const { data, isLoading } = useLauncherForProject(worktree.projectId);
  const launch = useLaunch();
  const setPreferred = useSetPreferredLauncher();

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Detecting apps…</div>;
  }

  const entries = data?.entries ?? [];
  const preferredId = data?.preferred ?? entries[0]?.id ?? null;
  if (entries.length === 0 || !preferredId) {
    return (
      <div className="text-sm text-muted-foreground">
        No launchers detected. Install a supported editor (Cursor, VS Code,
        Zed…) or add commands under <span className="font-mono">launchers</span>{" "}
        in <span className="font-mono">shigoto.json</span>.
      </div>
    );
  }

  const preferred = entries.find((e) => e.id === preferredId) ?? entries[0];

  const run = (entry: LauncherEntry) => {
    launch.mutate({
      projectId: worktree.projectId,
      worktreeId: worktree.id,
      launcherId: entry.id,
    });
  };

  const pickAndRun = (entry: LauncherEntry) => {
    setPreferred.mutate({
      projectId: worktree.projectId,
      launcherId: entry.id,
    });
    run(entry);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center">
        <Button
          size="sm"
          onClick={() => run(preferred)}
          disabled={launch.isPending}
          className="rounded-r-none border-r border-r-foreground/10"
        >
          {preferred.kind === "detected" ? (
            <IconFor name={preferred.icon} />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          <span>
            {launch.isPending ? "Launching…" : `Open in ${preferred.label}`}
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                className="rounded-l-none px-2"
                aria-label="Choose launcher"
              >
                <ChevronDown className="size-3.5" />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            {entries.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                onClick={() => pickAndRun(entry)}
                className={cn(entry.id === preferredId && "bg-accent/60")}
              >
                {entry.kind === "detected" ? (
                  <IconFor name={entry.icon} />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                <span>{entry.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {launch.error && (
        <div className="text-xs text-destructive">{launch.error.message}</div>
      )}
    </div>
  );
}
