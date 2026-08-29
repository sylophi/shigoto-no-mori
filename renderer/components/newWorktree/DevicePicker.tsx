// The new-worktree device section: where the worktree is created and
// where its scripts run. Radio cards, this device first, every enrolled
// peer after it -- including the ones that can't take the job, which
// stay visible with the reason instead of vanishing, so "why isn't the
// Thinkpad here" is never a question the page leaves open.
//
// Selection is emerald (mint under doubutsu) and unavailability is
// amber: a peer that is offline, has no checkout of this repo, or hasn't
// granted command access is a calm state, not an error. Both tones ride
// fills rather than borders, since the doubutsu overlay strips every
// border and ring.
import { Monitor } from "lucide-react";
import { StatusDot } from "@/components/ui/status-dot";
import { tildify } from "@/lib/projectPaths";
import { cn } from "@/lib/utils";
import type { DeviceBlock, DeviceTarget } from "./deviceTargets";

// Honest and specific, and none of them offer a fix here: reconnecting
// is the relay's job, granting happens on the other machine's Devices
// page, and cloning a missing repo is not something this form does.
const BLOCK_REASON: Record<DeviceBlock, string> = {
  offline: "Creating needs a live connection.",
  "no-project":
    "Doesn't have this repo registered — matching by git remote found no checkout there.",
  "no-grant": "Read-only until it grants command access from its Devices page.",
};

export function DevicePicker({
  targets,
  selectedId,
  onSelect,
  home,
}: {
  targets: readonly DeviceTarget[];
  selectedId: string;
  onSelect: (deviceId: string) => void;
  // This machine's homedir, for abbreviating its own path. A peer's
  // paths stay absolute: runtime info is local-only, so there is no
  // home to measure them against and a guessed "~" would be a lie.
  home: string | null;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="block text-sm font-medium">Device</span>
        <span className="text-xs text-muted-foreground">
          Where the worktree is created and where its scripts run.
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label="Device"
        className="flex flex-col gap-1.5"
      >
        {targets.map((target) => (
          <DeviceOption
            key={target.deviceId}
            target={target}
            selected={target.deviceId === selectedId}
            onSelect={onSelect}
            home={home}
          />
        ))}
      </div>
    </div>
  );
}

function DeviceOption({
  target,
  selected,
  onSelect,
  home,
}: {
  target: DeviceTarget;
  selected: boolean;
  onSelect: (deviceId: string) => void;
  home: string | null;
}) {
  const blocked = target.block !== undefined;
  const path = target.project
    ? target.isThisDevice
      ? tildify(target.project.path, home)
      : target.project.path
    : null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={blocked}
      onClick={() => onSelect(target.deviceId)}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
        blocked
          ? "cursor-default border-amber-500/40 bg-amber-500/10"
          : selected
            ? "border-emerald-500 bg-emerald-500/15"
            : "border-border bg-card hover:bg-muted",
      )}
    >
      {/* The pick itself. A filled disc rather than a hollow ring: the
          overlay strips borders, and an outline-only radio would leave
          doubutsu with nothing to mark the row by. */}
      <span
        className={cn(
          "mt-1 size-3 shrink-0 rounded-full",
          selected
            ? "bg-emerald-500"
            : blocked
              ? "bg-amber-500/40"
              : "bg-muted-foreground/30",
        )}
      />
      <Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2">
          <span className="truncate text-sm font-medium">{target.label}</span>
          {target.status && (
            <StatusDot
              tone={target.status.tone}
              label={
                <span className="text-xs text-muted-foreground">
                  {target.status.label}
                </span>
              }
            />
          )}
          {target.isThisDevice && (
            <span className="text-xs text-muted-foreground">this device</span>
          )}
        </span>
        {path && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {path}
          </span>
        )}
        {target.block && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            {BLOCK_REASON[target.block]}
          </span>
        )}
      </span>
      {target.worktreeCount !== undefined && (
        <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">
          {target.worktreeCount} worktree{target.worktreeCount === 1 ? "" : "s"}
        </span>
      )}
    </button>
  );
}
