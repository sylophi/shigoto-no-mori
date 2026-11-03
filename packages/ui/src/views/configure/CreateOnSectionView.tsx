// The Configure page's "Create on" pick: which device the project
// header's `+` creates a worktree on, out of every device holding this
// repo -- the same list the new-worktree form's device picker draws
// (useDeviceTargets), minus the ones with no checkout. It is a shared
// setting rather than a key in project.json: the repo has a project
// file on every device, and one pick has to hold across all of them,
// whichever device it is made from. A project held on one device alone
// has nothing to pick, so the section stays out.
import { RadioGroup } from "@base-ui/react/radio-group";
import { DeviceGlyphView } from "../shared/DeviceGlyphView.tsx";
import type { DeviceBlock, DeviceTarget } from "../../lib/deviceRoster.ts";
import { OptionCard } from "../../primitives/option-card.tsx";
import { RowTag } from "../../primitives/row-tag.tsx";
import { SectionIntro } from "../../primitives/section-heading.tsx";
import { THIS_DEVICE_VIEW } from "../../lib/deviceStatus.ts";
import { cn } from "../../lib/utils.ts";

// A device holding the repo.
export type CreateOnHolder = Pick<
  DeviceTarget,
  "deviceId" | "label" | "icon" | "isThisDevice" | "block"
>;

export function CreateOnSectionView({
  holders,
  blockReasons,
  current,
  waiting,
  onPick,
}: {
  holders: readonly CreateOnHolder[];
  // Why a blocked device can't take a create now.
  blockReasons: Readonly<Record<DeviceBlock, string>>;
  // The device the + creates on: the pick, or the fallback.
  current: string | undefined;
  // The pick is blocked, and the + falls back meanwhile.
  waiting: { picked: string; fallback: string } | null;
  onPick: (deviceId: string) => void;
}) {
  return (
    <section className="space-y-3">
      <SectionIntro title="Create on">
        The device where this project&apos;s + button creates new worktrees.
      </SectionIntro>
      <RadioGroup<string | null>
        value={current ?? null}
        onValueChange={(deviceId) => {
          if (deviceId !== null) onPick(deviceId);
        }}
        aria-label="Create on"
        className="flex flex-col gap-1"
      >
        {holders.map((holder) => (
          <OptionCard
            key={holder.deviceId}
            value={holder.deviceId}
            // A peer with no grant would refuse every create. The other
            // blocks are calm states a pick can wait out.
            disabled={holder.block === "no-grant"}
            className={cn(
              holder.block !== undefined &&
                "not-data-checked:cursor-default not-data-checked:border-amber-500/40 not-data-checked:bg-amber-500/10 not-data-checked:enabled:hover:bg-amber-500/10",
            )}
            title={
              <>
                <DeviceGlyphView
                  icon={holder.icon}
                  className="size-3.5 text-muted-foreground"
                />
                <span className="truncate">{holder.label}</span>
                {holder.isThisDevice && (
                  <RowTag>{THIS_DEVICE_VIEW.label}</RowTag>
                )}
              </>
            }
            detail={
              holder.block === undefined ? undefined : (
                <span className="text-amber-600 dark:text-amber-400">
                  {blockReasons[holder.block]}
                </span>
              )
            }
          />
        ))}
      </RadioGroup>
      {waiting !== null && (
        <p className="text-xs text-muted-foreground">
          {waiting.picked} isn&apos;t available right now, so + creates on{" "}
          {waiting.fallback} until it is.
        </p>
      )}
    </section>
  );
}
