// The mirror's first step, answering what the start does in the order
// a person asks it: which worktree is kept in step with which (the
// pair, the copy's end being where it lands, or the pick of where for
// a mirror to a peer), then the one real choice (what stays out), then
// whether the copy's create runs its setup script. Single column, the
// pair first, since everything else hangs off it. The source half
// reads the device the dialog is scoped to, the copy's half re-pins to
// the landing device (DestinationScope), like the transplant's review.
import { ArrowLeftRight, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { pullWorktreeName } from "@shared/git/branches";
import type { Project, Worktree } from "@shared/schemas";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useWorktreeBaseLabel } from "@/hooks/config/useWorktreeBaseLabel";
import {
  DestinationScope,
  useDestinationScope,
  useHostScope,
} from "@/hooks/remote/useHostScope";
import { useDeviceIcon } from "@/hooks/remote/useRemoteDevices";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import {
  CloneDestinationSection,
  type LandingTarget,
} from "../flow/cloneDestination";
import { useCreatePlan } from "../flow/createPlan";
import { FlowBody } from "../flow/FlowChrome";
import type { PullChoiceState } from "../flow/ignoreChoice";
import { isReadyTarget } from "../flow/peerTargets";
import { PullLeaveOut } from "../flow/PullLeaveOut";
import {
  type DestinationPick,
  PullReviewFooter,
  useLocalCollision,
} from "../flow/PullReview";
import type { Landing } from "../flow/pullSteps";

export function MirrorReview({
  worktree,
  project,
  target,
  sourceDeviceLabel,
  thisDeviceLabel,
  landing,
  toPeer,
  pull,
  onCancel,
  onStart,
}: {
  // The original, on the device the dialog is scoped to.
  worktree: Worktree;
  project: Project;
  // Where the copy lands (flow/cloneDestination.tsx), null until a
  // mirror to a peer has its pick.
  target: LandingTarget | null;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  landing: Landing;
  toPeer: DestinationPick | undefined;
  pull: PullChoiceState;
  onCancel: () => void;
  onStart: () => void;
}) {
  return (
    <>
      <FlowBody>
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 rounded-lg bg-muted/40 px-4 py-3">
            <OriginalEnd worktree={worktree} name={sourceDeviceLabel} />
            <ArrowLeftRight
              aria-label="kept in step both ways"
              className="size-4 text-muted-foreground"
            />
            <DestinationScope>
              <CopyEnd
                worktree={worktree}
                target={target}
                name={thisDeviceLabel}
                landing={landing}
                toPeer={toPeer}
              />
            </DestinationScope>
          </div>

          {target?.clone && (
            <DestinationScope>
              <CloneDestinationSection
                clone={target.clone}
                thisDeviceLabel={thisDeviceLabel}
              />
            </DestinationScope>
          )}

          <PullLeaveOut
            pull={pull}
            worktree={{
              projectId: project.id,
              id: worktree.id,
              path: worktree.path,
            }}
          />

          {target?.project && (
            <DestinationScope>
              <SetupRow
                localProject={target.project}
                deviceLabel={thisDeviceLabel}
                checked={pull.runSetup}
                onChange={pull.setRunSetup}
              />
            </DestinationScope>
          )}
        </div>
      </FlowBody>

      <DestinationScope>
        <PullReviewFooter
          worktree={worktree}
          target={target}
          landing={landing}
          waiting={pull.waiting}
          blocked={pull.blocked}
          idleNote=""
          startLabel="Start mirroring"
          onCancel={onCancel}
          onStart={onStart}
        />
      </DestinationScope>
    </>
  );
}

// One end of the pair: the device, its part, and a line about the
// worktree there.
function End({
  icon,
  name,
  part,
  children,
  align = "start",
}: {
  icon: DeviceIcon;
  name: ReactNode;
  part: string;
  children: ReactNode;
  align?: "start" | "end";
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 leading-tight",
        align === "end" && "items-end text-right",
      )}
    >
      <span
        className={cn(
          "flex max-w-full min-w-0 items-center gap-1.5",
          align === "end" && "flex-row-reverse",
        )}
      >
        <DeviceGlyph
          icon={icon}
          className="size-4 shrink-0 text-muted-foreground"
        />
        {typeof name === "string" ? (
          <span className="min-w-0 truncate text-sm font-medium">{name}</span>
        ) : (
          name
        )}
        <span className="shrink-0 text-xs text-muted-foreground">{part}</span>
      </span>
      <span className="max-w-full min-w-0 truncate text-xs text-muted-foreground">
        {children}
      </span>
    </div>
  );
}

// The original: its folder, and the uncommitted work that comes along
// (a mirror carries it, so it is said rather than asked).
function OriginalEnd({ worktree, name }: { worktree: Worktree; name: string }) {
  const icon = useDeviceIcon(useHostScope().deviceId);
  return (
    <End icon={icon} name={name} part="original">
      <span className="font-mono">{worktree.name}</span>
      {worktree.changedCount > 0 &&
        ` · ${pluralize(worktree.changedCount, "uncommitted file")}`}
    </End>
  );
}

// The copy: where it lands, the branch when it lands on another name
// (a primary checkout's copy, shared/git/branches.ts), and for a
// mirror to a peer the pick of which peer, in place of the name. A
// collision the landing would refuse marks the folder line, and the
// footer says why.
function CopyEnd({
  worktree,
  target,
  name,
  landing,
  toPeer,
}: {
  worktree: Worktree;
  target: LandingTarget | null;
  name: string;
  landing: Landing;
  toPeer: DestinationPick | undefined;
}) {
  const icon = useDeviceIcon(useDestinationScope().deviceId);
  const where =
    target === null ? (
      "Pick where the copy goes"
    ) : target.clone ? (
      "a new checkout, cloned first"
    ) : (
      <FolderLine
        worktree={worktree}
        project={target.project}
        landing={landing}
      />
    );
  return (
    <End
      icon={icon}
      name={
        toPeer ? (
          <DevicePick toPeer={toPeer} name={name} picked={target !== null} />
        ) : (
          name
        )
      }
      part="copy"
      align="end"
    >
      {where}
    </End>
  );
}

// Where the copy lands in a checkout the device has: the folder (the
// whole path on hover), and the branch when it lands on another name
// (a primary checkout's copy, shared/git/branches.ts). A collision the
// landing would refuse tints it, and the footer says why.
function FolderLine({
  worktree,
  project,
  landing,
}: {
  worktree: Worktree;
  project: Project;
  landing: Landing;
}) {
  const { landingBranch, refusal } = useLocalCollision(
    project,
    worktree,
    landing,
  );
  const base = useWorktreeBaseLabel(project);
  const folder = pullWorktreeName(worktree);
  if (base === null) return <Skeleton className="h-3 w-40" />;
  return (
    <SimpleTooltip tip={`${base}/${folder ?? "‹new name›"}`}>
      <span
        className={cn(
          "font-mono",
          refusal !== null && "text-amber-700 dark:text-amber-300",
        )}
      >
        {landingBranch !== worktree.branch ? `${landingBranch} in ` : ""}
        {folder ?? "a new folder"}
      </span>
    </SimpleTooltip>
  );
}

// A mirror to a peer picks the peer in place: the copy end's name is
// the menu. A device that cannot take it right now is listed, held,
// with why.
function DevicePick({
  toPeer,
  name,
  picked,
}: {
  toPeer: DestinationPick;
  name: string;
  picked: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="-mx-1 inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-md px-1 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Device the copy goes to"
      >
        <span className="min-w-0 truncate">
          {picked ? name : "Pick a device"}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuRadioGroup
          value={toPeer.pickedId ?? ""}
          onValueChange={(deviceId) => toPeer.onPick(String(deviceId))}
        >
          {toPeer.targets.map((candidate) => (
            <DropdownMenuRadioItem
              key={candidate.deviceId}
              value={candidate.deviceId}
              disabled={!isReadyTarget(candidate)}
            >
              <DeviceGlyph
                icon={candidate.icon}
                className="size-4 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
              <span className="text-xs text-muted-foreground">
                {candidate.block === "offline"
                  ? "offline"
                  : candidate.block === "no-grant"
                    ? "read-only"
                    : candidate.project
                      ? ""
                      : "clones first"}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Whether the copy's create runs the project's setup script there, as
// one row. A project without one says so and offers nothing.
function SetupRow({
  localProject,
  deviceLabel,
  checked,
  onChange,
}: {
  localProject: Project;
  deviceLabel: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const command = useCreatePlan(localProject).setupCommand;
  if (command === "") return null;
  return (
    <label className="flex cursor-pointer items-center gap-3">
      <span className="min-w-0 flex-1 text-sm">
        Run the setup script on {deviceLabel}
        <span className="ml-2 font-mono text-xs text-muted-foreground">
          {command}
        </span>
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label="Run the setup script"
      />
    </label>
  );
}
