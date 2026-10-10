// The devices' own terminals, the ones no worktree holds, under the
// forest: each device that has some, by name, over a row per terminal
// named for the folder it started in. The section shows only while
// some device has one.
import type { ReactNode } from "react";
import { SquareTerminal } from "lucide-react";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import { DeviceLeadView } from "@shigomori/ui/views/shared/DeviceGlyphView.tsx";
import type { StatusTone } from "@shigomori/ui/primitives/status-dot.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";

export function SidebarTerminalsView({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Terminals"
      className="flex shrink-0 flex-col gap-2 px-2 py-2 empty:hidden"
    >
      {children}
    </section>
  );
}

export type SidebarTerminalRow = {
  readonly terminalId: string;
  readonly label: string;
  // The folder in full, behind a cut-off label.
  readonly cwd: string;
  readonly selected: boolean;
};

export function SidebarDeviceTerminalsView({
  label,
  icon,
  tone,
  terminals,
  onPick,
}: {
  label: string;
  icon: DeviceIcon;
  // Null for this device, which has no connection to show.
  tone: StatusTone | null;
  terminals: readonly SidebarTerminalRow[];
  onPick: (terminalId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5 px-2 text-2xs text-muted-foreground">
        <DeviceLeadView icon={icon} tone={tone} size="xs" />
        <span className="truncate">{label}</span>
      </div>
      {terminals.map((terminal) => (
        <button
          key={terminal.terminalId}
          type="button"
          aria-current={terminal.selected ? "page" : undefined}
          onClick={() => onPick(terminal.terminalId)}
          className={cn(
            "flex h-7 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
            terminal.selected
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <SquareTerminal className="size-3.5 shrink-0" />
          <SimpleTooltip whenTruncated tip={terminal.cwd}>
            <span className="truncate font-mono text-xs">{terminal.label}</span>
          </SimpleTooltip>
        </button>
      ))}
    </div>
  );
}
