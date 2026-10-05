// The mirror's first step: two cards side by side, the original and
// the copy, each a header band naming its device and a body naming the
// worktree there, so the pair reads at a glance the way the manage
// dialog shows it once it runs. Under the original, what stays out
// (the one real choice); in the copy's card, whether its create runs
// the setup script. A mirror to a peer picks the peer in the copy
// card's header. The original's card is the transplant's source card. The
// copy's half re-pins to the landing device (DestinationScope).
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { pullWorktreeName } from "@shared/git/branches";
import type { Project, Worktree } from "@shared/schemas";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import { FolderPickerModal } from "@/components/shared/FolderPickerModal";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { useWorktreeBaseLabel } from "@/hooks/config/useWorktreeBaseLabel";
import {
  DestinationScope,
  useDestinationScope,
} from "@/hooks/remote/useHostScope";
import {
  useDeviceIcon,
  useRemoteDevice,
} from "@/hooks/remote/useRemoteDevices";
import { localDeviceId } from "@/lib/queryKeys";
import { deviceStatusView, THIS_DEVICE_VIEW } from "@/lib/remote/deviceStatus";
import { cn } from "@/lib/utils";
import type { LandingTarget } from "../flow/cloneDestination";
import { FlowBody } from "../flow/FlowChrome";
import type { PullChoiceState } from "../flow/ignoreChoice";
import { isReadyTarget } from "../flow/peerTargets";
import { PullLeaveOut } from "../flow/PullLeaveOut";
import {
  type DestinationPick,
  PullReviewFooter,
  SourceCard,
  useLocalCollision,
} from "../flow/PullReview";
import type { Landing } from "../flow/pullSteps";
import { useCreatePlan } from "../flow/createPlan";

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
        <div className="grid gap-5 md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-5">
            <section className="space-y-2">
              <SectionHeading>Original</SectionHeading>
              <SourceCard
                worktree={worktree}
                project={project}
                sourceDeviceLabel={sourceDeviceLabel}
              />
            </section>
            <PullLeaveOut
              pull={pull}
              worktree={{
                projectId: project.id,
                id: worktree.id,
                path: worktree.path,
              }}
            />
          </div>

          <DestinationScope>
            <div className="flex min-w-0 flex-col gap-5">
              <section className="space-y-2">
                <SectionHeading>Copy</SectionHeading>
                <CopyCard
                  worktree={worktree}
                  target={target}
                  deviceLabel={thisDeviceLabel}
                  landing={landing}
                  toPeer={toPeer}
                  pull={pull}
                />
              </section>
            </div>
          </DestinationScope>
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

// The copy's card, the source card's twin: the landing device in the
// header band (the pick of it, for a mirror to a peer) with its state
// and the project there, and the worktree the copy becomes in the
// body. With no checkout of the repo there the body is the clone that
// makes one, its folder changeable.
function CopyCard({
  worktree,
  target,
  deviceLabel,
  landing,
  toPeer,
  pull,
}: {
  worktree: Worktree;
  target: LandingTarget | null;
  deviceLabel: string;
  landing: Landing;
  toPeer: DestinationPick | undefined;
  pull: PullChoiceState;
}) {
  const { deviceId } = useDestinationScope();
  const device = useRemoteDevice(deviceId);
  const icon = useDeviceIcon(deviceId);
  const status =
    target === null
      ? null
      : deviceId === localDeviceId
        ? THIS_DEVICE_VIEW
        : device
          ? deviceStatusView(device.status)
          : null;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm">
        <DeviceGlyph icon={icon} className="size-4 text-muted-foreground" />
        {toPeer ? (
          <DevicePick
            toPeer={toPeer}
            name={deviceLabel}
            picked={target !== null}
          />
        ) : (
          <span className="font-medium">{deviceLabel}</span>
        )}
        {status && (
          <StatusDot
            tone={status.tone}
            label={
              <span className="text-xs text-muted-foreground">
                {status.label.toLowerCase()}
              </span>
            }
          />
        )}
        <span className="ml-auto truncate text-xs text-muted-foreground">
          {target?.project?.name ??
            (target?.clone ? "new checkout" : undefined)}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        {target === null ? (
          <p className="text-xs text-muted-foreground">
            Pick the device the copy goes to.
          </p>
        ) : target.project ? (
          <LandingLines
            worktree={worktree}
            project={target.project}
            landing={landing}
          />
        ) : (
          <CloneLines clone={target.clone} worktree={worktree} />
        )}
      </div>
      {target?.project && (
        <SetupRow
          localProject={target.project}
          checked={pull.runSetup}
          onChange={pull.setRunSetup}
        />
      )}
    </div>
  );
}

// The copy card's last row: whether its create runs the project's
// setup script there. A project without one has no row.
function SetupRow({
  localProject,
  checked,
  onChange,
}: {
  localProject: Project;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const command = useCreatePlan(localProject).setupCommand;
  const id = useId();
  if (command === "") return null;
  return (
    <div className="flex items-center gap-3 border-t border-border px-3 py-2.5">
      <label
        htmlFor={id}
        className="min-w-0 flex-1 cursor-pointer leading-tight"
      >
        <span className="block text-xs font-medium">Run the setup script</span>
        <span className="block truncate font-mono text-xs text-muted-foreground">
          {command}
        </span>
      </label>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-label="Run the setup script"
      />
    </div>
  );
}

// The worktree the copy becomes in a checkout already there: its
// branch (another name for a primary checkout's copy) and folder name,
// then the whole path, as the source card lays out the original. A
// branch or folder the landing would refuse tints the line, and the
// footer says why.
function LandingLines({
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
  return (
    <>
      <p
        className={cn(
          "flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono",
          refusal !== null && "text-amber-700 dark:text-amber-300",
        )}
      >
        <span className="text-sm font-semibold">{landingBranch}</span>
        <span className="text-xs text-muted-foreground">
          {folder ?? "new folder"}
        </span>
      </p>
      {base === null ? (
        <Skeleton className="h-3.5 w-2/3" />
      ) : (
        <p className="truncate font-mono text-xs text-muted-foreground">
          {base}/{folder ?? "‹new name›"}
        </p>
      )}
    </>
  );
}

// No checkout of the repo there: the copy lands in a clone made first,
// whose folder can be changed.
function CloneLines({
  clone,
  worktree,
}: {
  clone: NonNullable<LandingTarget["clone"]>;
  worktree: Worktree;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <>
      <p className="font-mono text-sm font-semibold">{worktree.branch}</p>
      <div className="flex items-center gap-2">
        <PathSpan
          path={clone.dest}
          home={null}
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        />
        <Button variant="outline" size="xs" onClick={() => setPicking(true)}>
          Change
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        No checkout of {clone.projectName} there yet, so it&rsquo;s cloned
        first.
      </p>
      {picking && (
        <FolderPickerModal
          initialPath={clone.cloneInto.parentDir}
          title="Clone into"
          hint={`${clone.projectName} becomes a new folder inside the one you pick.`}
          onPick={(chosen) => {
            clone.setParent(chosen);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  );
}

// A mirror to a peer picks the peer in the copy card's header: its
// name is the menu. A device that cannot take the copy right now is
// listed, held, with why.
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
        className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1 font-medium whitespace-nowrap outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-label="Device the copy goes to"
      >
        {picked ? name : "Pick a device"}
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
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
