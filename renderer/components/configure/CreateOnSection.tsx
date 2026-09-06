// The Configure page's "Create on" pick: which device the project
// header's `+` creates a worktree on, out of every device holding this
// repo -- the same list the new-worktree form's device picker draws
// (useDeviceTargets), minus the ones with no checkout. The same
// preference the header's own menu offers, written the same way, so
// the two can't disagree. It is a preference of the client making the
// pick, kept in its client config rather than in project.json: the
// repo has a project file on every device, and one pick has to hold
// across all of them. A project held on one device alone has nothing
// to pick, so the section stays out.
import { Check } from "lucide-react";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  useQuickCreateDeviceId,
  useSetQuickCreateDevice,
} from "@/hooks/config/useQuickCreateDevice";
import { cn } from "@/lib/utils";
import type { Project } from "@shared/schemas";
import { BLOCK_REASON } from "../newWorktree/DevicePicker";
import { useDeviceTargets } from "../newWorktree/deviceTargets";

export function CreateOnSection({ project }: { project: Project }) {
  const holders = useDeviceTargets(project).filter(
    (target) => target.project !== undefined,
  );
  const picked = useQuickCreateDeviceId(project.identity);
  const setDevice = useSetQuickCreateDevice(project.identity);
  if (holders.length < 2) return null;

  // The `+` falls back to the first holder that can take a create now,
  // both when nothing is picked and while the pick is blocked (asleep,
  // no grant). The list ticks the pick and says so.
  const fallback = holders.find((holder) => holder.block === undefined);
  const current = picked ?? fallback?.deviceId;
  const pickedHolder = holders.find((holder) => holder.deviceId === picked);
  const pickBlocked =
    pickedHolder?.block !== undefined && fallback !== undefined;

  return (
    <section className="space-y-3">
      <div>
        <SectionHeading className="mb-1">Create on</SectionHeading>
        <p className="text-xs text-muted-foreground">
          Where this project&apos;s + creates a worktree. Applies right away,
          and is remembered by this app rather than written to the project.
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label="Create on"
        className="flex flex-col gap-1"
      >
        {holders.map((holder) => {
          const selected = holder.deviceId === current;
          const blocked = holder.block !== undefined;
          return (
            <button
              key={holder.deviceId}
              type="button"
              role="radio"
              aria-checked={selected}
              // A peer with no grant would refuse every create. The
              // other blocks are calm states a pick can wait out.
              disabled={holder.block === "no-grant"}
              onClick={() => setDevice(holder.deviceId)}
              className={cn(
                "flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                selected
                  ? "border-emerald-500 bg-emerald-500/15"
                  : blocked
                    ? "cursor-default border-amber-500/40 bg-amber-500/10"
                    : "border-border bg-card hover:bg-muted",
              )}
            >
              <span className="flex items-center gap-2">
                <Check
                  className={cn("size-3.5 shrink-0", !selected && "opacity-0")}
                />
                <span className="truncate">{holder.label}</span>
                {holder.isThisDevice && (
                  <span className="text-xs text-muted-foreground">
                    this device
                  </span>
                )}
              </span>
              {holder.block !== undefined && (
                <span className="pl-5.5 text-xs text-amber-600 dark:text-amber-400">
                  {BLOCK_REASON[holder.block]}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {pickBlocked && fallback && (
        <p className="text-xs text-muted-foreground">
          Until {pickedHolder.label} can take it, the + creates on{" "}
          {fallback.label}.
        </p>
      )}
    </section>
  );
}
