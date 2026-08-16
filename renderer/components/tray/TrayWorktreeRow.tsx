import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { LauncherIcon } from "@/components/LauncherIcon";
import { FileManagerIcon } from "@/components/ui/file-manager";
import { cn } from "@/lib/utils";
import type { LauncherEntry, Worktree } from "@shared/schemas";
import { StatusDot } from "./StatusDot";
import { trayStatus } from "./trayStatus";

export function trayRowId(worktreeId: string): string {
  return `tray-row-${worktreeId}`;
}

interface TrayWorktreeRowProps {
  worktree: Worktree;
  selected: boolean;
  // The project's top launcher, offered inline on the selected row.
  // Null while it loads, or when the project has none configured.
  launcher: LauncherEntry | null;
  onSelect: () => void;
  onActivate: () => void;
  onLaunch: (launcherId: string) => void;
  onReveal: () => void;
}

// One worktree. The dot is the glance signal; the count on the right is
// the detail you read only after the dot caught your eye. Quick actions
// replace the count on the selected row -- showing both would put four
// things in a 340px row, and the popover is meant to stay calm.
export function TrayWorktreeRow({
  worktree,
  selected,
  launcher,
  onSelect,
  onActivate,
  onLaunch,
  onReveal,
}: TrayWorktreeRowProps) {
  const status = trayStatus(worktree);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    onActivate();
  };

  return (
    <div
      role="option"
      id={trayRowId(worktree.id)}
      aria-selected={selected}
      aria-label={`${worktree.name} — ${status.title}`}
      tabIndex={-1}
      title={`${worktree.branch} — ${status.title}`}
      onClick={onActivate}
      onKeyDown={onKeyDown}
      onMouseMove={onSelect}
      className={cn(
        "flex h-7 items-center gap-2 rounded-md px-2 outline-none transition-colors",
        "aria-selected:bg-accent aria-selected:text-accent-foreground",
      )}
    >
      <StatusDot status={status.status} />
      <span className="min-w-0 flex-1 truncate text-xs">{worktree.name}</span>
      {selected ? (
        <span className="flex shrink-0 items-center gap-0.5">
          {launcher ? (
            <TrayRowAction
              label={`Open in ${launcher.label}`}
              onClick={() => onLaunch(launcher.id)}
            >
              <LauncherIcon entry={launcher} className="size-3.5" />
            </TrayRowAction>
          ) : null}
          <TrayRowAction label="Reveal in Finder" onClick={onReveal}>
            <FileManagerIcon className="size-3.5" />
          </TrayRowAction>
        </span>
      ) : (
        status.label && (
          <span className="tabular shrink-0 text-[10px] text-muted-foreground">
            {status.label}
          </span>
        )
      )}
    </div>
  );
}

function TrayRowAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // Focus stays in the filter field (roving selection, matching the
      // project launcher), so these never enter the tab order.
      tabIndex={-1}
      title={label}
      aria-label={label}
      onClick={(e) => {
        // The row itself navigates on click; an action is not that.
        e.stopPropagation();
        onClick();
      }}
      className="flex size-5 items-center justify-center rounded-sm opacity-70 transition-opacity hover:opacity-100"
    >
      {children}
    </button>
  );
}
