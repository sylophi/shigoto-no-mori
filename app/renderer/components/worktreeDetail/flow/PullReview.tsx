// The review step the transplant and the mirror both wear: the source
// card, the destination card (with the pick of a peer and the setup
// switch), the collision check and the footer band. Each flow's own review composes
// them around what only it shows. The destination is this machine
// unless the flow is a transplant to a peer (DestinationScope), so
// `localProject` and `thisDeviceLabel` name the landing side, whichever
// machine that is.
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  FilePen,
  GitPullRequest,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import type {
  Project,
  PullRequestDetail,
  Worktree,
} from "@shigomori/contracts/schemas";
import {
  pullBranchCollision,
  pullFolderCollision,
} from "@shared/pullCollision";
import { pullLandingBranch, pullWorktreeName } from "@shared/git/branches";
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
import { Switch } from "@/components/ui/switch";
import { useWorktreeBaseLabel } from "@/hooks/config/useWorktreeBaseLabel";
import { useBranches } from "@/hooks/git/useBranches";
import {
  DestinationScope,
  useDestinationScope,
  useHostScope,
} from "@/hooks/remote/useHostScope";
import { useDeviceIcon } from "@/hooks/remote/useRemoteDevices";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { cn } from "@/lib/utils";
import { worktreeTitle } from "@/lib/worktreeTitle";
import type { LandingTarget } from "./cloneDestination";
import { useCreatePlan } from "./createPlan";
import type { PullChoiceState } from "./ignoreChoice";
import { PullLeaveOut } from "./PullLeaveOut";
import { FlowBody, FlowFooter } from "./FlowChrome";
import { isReadyTarget, type PeerTarget } from "./peerTargets";
import { type Landing, LANDS_HERE } from "./pullSteps";

// The destination's pick, for a flow to a peer: the devices that could
// take the worktree and the way to choose which one does (the
// destination card's header). Until one is picked there is no landing
// project, so the card asks for the pick and Start waits.
export type DestinationPick = {
  targets: PeerTarget[];
  pickedId: string | null;
  onPick: (deviceId: string) => void;
};

// Where the pull would refuse at step 2 (host/ipc/modules/sync.ts
// runPullWorktree): the landing device already has the branch, checked
// out in a worktree or merely existing, or already has a worktree
// under the folder name the copy would take. Read under
// DestinationScope. Both lists are the ordinary cached ones, so the
// row and the footer asking the same question cost one read between
// them. The disk half of the folder rule (a stray folder that is no
// worktree) is the host's alone. With no landing project yet (a flow
// to a peer before its pick) nothing is read and nothing refuses. The
// branch asked about is the one the copy lands on (pullLandingBranch).
function useLocalCollision(
  localProject: Project | undefined,
  worktree: Worktree,
  landing: Landing = LANDS_HERE,
): {
  // The branch the copy lands on.
  landingBranch: string;
  // The refusal the footer shows and Start waits on, or null.
  refusal: string | null;
} {
  const { data: branches } = useBranches(localProject?.id ?? null);
  const { data: worktrees } = useWorktrees(localProject?.id ?? null);
  const landingBranch = pullLandingBranch(worktree);
  const held = branches?.local.includes(landingBranch) ?? false;
  const holder = held
    ? worktrees?.find((entry) => entry.branch === landingBranch)
    : undefined;
  const name = pullWorktreeName(worktree);
  const taken =
    name !== undefined &&
    (worktrees?.some(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    ) ??
      false);
  // A peer's refusal names the peer. This device's keeps its own words.
  const where = landing.onPeer ? landing.on : undefined;
  const refusal =
    localProject === undefined
      ? null
      : held
        ? pullBranchCollision(landingBranch, holder?.path, where)
        : taken
          ? pullFolderCollision(name, `${localProject.name}/${name}`, where)
          : null;
  return { landingBranch, refusal };
}

// The review step's footer band, the transplant's and the mirror's:
// the collision refusal or the wait's reason when there is one, the
// flow's own reassurance when there is not, and the start button held
// until both clear. A flow to a peer with no destination picked yet
// has nothing to check, and the band asks for the pick.
function PullReviewFooter({
  worktree,
  target,
  landing,
  waiting,
  blocked,
  idleNote,
  startLabel,
  onCancel,
  onStart,
}: {
  worktree: Worktree;
  // Where the flow lands, null while unpicked. A clone has no project
  // to check for collisions in yet.
  target: LandingTarget | null;
  landing?: Landing;
  // The gitignored rule resolves over the ignored list: no start
  // before it lands, or the files step would bring everything.
  waiting: boolean;
  // The wait's reason when it will not end on its own.
  blocked: string | null;
  idleNote: string;
  startLabel: string;
  onCancel: () => void;
  onStart: () => void;
}) {
  const { refusal } = useLocalCollision(target?.project, worktree, landing);
  const unpicked = target === null;
  return (
    <FlowFooter
      note={
        refusal ??
        blocked ??
        (unpicked ? "Pick the device it goes to." : idleNote)
      }
    >
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        size="sm"
        onClick={onStart}
        disabled={refusal !== null || waiting || unpicked}
      >
        {startLabel}
        <ArrowRight />
      </Button>
    </FlowFooter>
  );
}

// What a flow's review step takes, the transplant's and the mirror's.
export type PullReviewProps = {
  worktree: Worktree;
  project: Project;
  // Where it lands (flow/cloneDestination.tsx): this machine's
  // project or the clone that makes one, or the picked peer's when the
  // flow goes to one (`toPeer`), null until one is picked.
  target: LandingTarget | null;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  landing?: Landing;
  toPeer?: DestinationPick;
  // The leave-out rule and the setup switch, the flows' shared pair.
  pull: PullChoiceState;
  onCancel: () => void;
  onStart: () => void;
};

// Step 1 of either flow, in two parts. The pair first, on a band of
// its own: the source card and the destination card side by side,
// joined by what the flow does between them (a move, or a mirror kept
// in step both ways), both the same height, so the two ends read as
// one thing. Then the options, on the page below the band: what stays
// out and a flow's own sections (`details`: the transplant's changes
// and carry-over), in a grid of their own. The source half reads the
// device the page is scoped to, the destination half and the footer
// re-pin to the landing device (DestinationScope).
export function PullReviewStep({
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
  link,
  sourceHeading,
  destinationHeading,
  idleNote,
  startLabel,
  details,
}: PullReviewProps & {
  // What joins the two ends: a move one way, or a mirror both ways.
  link: "move" | "mirror";
  // The two cards' headings, in the flow's words.
  sourceHeading: string;
  destinationHeading: string;
  // The footer's reassurance, "" for none, and its start button.
  idleNote: string;
  startLabel: string;
  // A flow's own sections, beside what stays out under the pair.
  details?: ReactNode;
}) {
  const Link = link === "mirror" ? ArrowLeftRight : ArrowRight;
  // What the work is called, read here in the source's scope: the copy
  // carries the title over, so both cards lead with it.
  const { data: pr } = useWorktreePullRequest(project.id, worktree.branch);
  const title = worktreeTitle(worktree, pr);
  return (
    <>
      <FlowBody>
        <div className="flex flex-col gap-6">
          <div className="relative grid overflow-hidden rounded-xl border border-border bg-card md:grid-cols-2">
            <SourceCard
              heading={sourceHeading}
              title={title}
              pr={pr}
              worktree={worktree}
              project={project}
              sourceDeviceLabel={sourceDeviceLabel}
            />
            <DestinationScope>
              <DestinationCard
                heading={destinationHeading}
                title={title}
                worktree={worktree}
                target={target}
                deviceLabel={thisDeviceLabel}
                landing={landing ?? LANDS_HERE}
                toPeer={toPeer}
                pull={pull}
              />
            </DestinationScope>
            {/* On the seam between the halves: what the flow does from
                one to the other. */}
            <span className="pointer-events-none absolute top-1/2 left-1/2 hidden size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground md:flex">
              <Link
                aria-label={
                  link === "mirror" ? "kept in step both ways" : "moves to"
                }
                className="size-4"
              />
            </span>
          </div>

          <div
            className={cn(
              "grid gap-6",
              details !== undefined && "md:grid-cols-2",
            )}
          >
            <PullLeaveOut
              pull={pull}
              worktree={{
                projectId: project.id,
                id: worktree.id,
                path: worktree.path,
              }}
            />
            {details !== undefined && (
              <div className="flex min-w-0 flex-col gap-6">{details}</div>
            )}
          </div>
        </div>
      </FlowBody>

      <DestinationScope>
        <PullReviewFooter
          worktree={worktree}
          target={target}
          landing={landing}
          waiting={pull.waiting}
          blocked={pull.blocked}
          idleNote={idleNote}
          startLabel={startLabel}
          onCancel={onCancel}
          onStart={onStart}
        />
      </DestinationScope>
    </>
  );
}

// One half of the pair's card: the flow's word for this end, the
// device (and the project there), then the worktree, the body growing
// so a last row sits at the bottom of either half alike. The second
// half takes the seam (a rule beside it, or above it once stacked).
function EndCard({
  heading,
  head,
  aside,
  children,
  foot,
}: {
  heading: string;
  head: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col border-border not-first:border-t md:not-first:border-t-0 md:not-first:border-l">
      <div className="flex flex-1 flex-col gap-1.5 px-5 py-4">
        <SectionHeading>{heading}</SectionHeading>
        <div className="flex items-center gap-2 pt-1 pb-1.5 text-sm">
          {head}
          <SimpleTooltip whenTruncated tip={aside}>
            <span className="ml-auto truncate text-xs text-muted-foreground">
              {aside}
            </span>
          </SimpleTooltip>
        </div>
        {children}
      </div>
      {foot}
    </section>
  );
}

// The card's title: what the work is called when it has a title, the
// branch on a quieter line under it, and the branch alone when not.
// The folder sits beside the branch.
function BranchLine({
  title,
  branch,
  folder,
  className,
}: {
  title: string | null;
  branch: string;
  folder: string | undefined;
  className?: string;
}) {
  const quiet = title !== null;
  return (
    <>
      {title !== null && (
        <SimpleTooltip whenTruncated tip={title}>
          <p className="min-w-0 truncate text-sm font-medium">{title}</p>
        </SimpleTooltip>
      )}
      <p
        className={cn(
          "flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono",
          quiet && "text-muted-foreground",
          className,
        )}
      >
        <span
          className={
            quiet ? "text-xs text-foreground/80" : "text-sm font-semibold"
          }
        >
          {branch}
        </span>
        {folder !== undefined && (
          <span className="text-xs text-muted-foreground">{folder}</span>
        )}
      </p>
    </>
  );
}

// One fact on the source's meta line: an icon and a few words.
function Fact({
  icon: Icon,
  children,
  className,
}: {
  icon: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <Icon aria-hidden className="size-3.5" />
      {children}
    </span>
  );
}

function SourceCard({
  heading,
  title,
  pr,
  worktree,
  project,
  sourceDeviceLabel,
}: {
  heading: string;
  title: string | null;
  pr: PullRequestDetail | null | undefined;
  worktree: Worktree;
  project: Project;
  sourceDeviceLabel: string;
}) {
  const { deviceId } = useHostScope();
  // The card sits in the source device's scope, so this is the PEER's
  // home, and a transplant already holds the grant that read needs.
  // Refused or not yet answered, the path shows as it is.
  const { data: runtime } = useRuntimeInfo();
  // Only what there is: a branch in step with its upstream, a clean
  // tree and no PR say nothing, so they show nothing.
  const facts = [
    worktree.ahead > 0 && (
      <Fact key="ahead" icon={ArrowUp}>
        {worktree.ahead} ahead
      </Fact>
    ),
    worktree.behind > 0 && (
      <Fact key="behind" icon={ArrowDown}>
        {worktree.behind} behind
      </Fact>
    ),
    worktree.changedCount > 0 && (
      <Fact
        key="dirty"
        icon={FilePen}
        className="text-amber-700 dark:text-amber-300"
      >
        {worktree.changedCount} uncommitted
      </Fact>
    ),
    pr && (
      <Fact key="pr" icon={GitPullRequest}>
        #{pr.number}
      </Fact>
    ),
  ].filter(Boolean);
  return (
    <EndCard
      heading={heading}
      head={
        <>
          <DeviceGlyph
            icon={useDeviceIcon(deviceId)}
            className="size-4 text-muted-foreground"
          />
          <span className="font-medium">{sourceDeviceLabel}</span>
        </>
      }
      aside={project.name}
    >
      <BranchLine
        title={title}
        branch={worktree.branch}
        folder={worktree.name}
      />
      <PathSpan
        path={worktree.path}
        home={runtime?.homedir ?? null}
        className="min-w-0 truncate font-mono text-xs text-muted-foreground"
      />
      {facts.length > 0 && (
        <p className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 text-xs text-muted-foreground tabular-nums">
          {facts}
        </p>
      )}
    </EndCard>
  );
}

// The destination's card, the source card's twin: the landing device
// and the project there in the header band (the pick of it, for a
// flow to a peer), and the worktree it becomes in the body. With no checkout of the repo there the body is the clone that
// makes one, its folder changeable.
function DestinationCard({
  heading,
  title,
  worktree,
  target,
  deviceLabel,
  landing,
  toPeer,
  pull,
}: {
  heading: string;
  title: string | null;
  worktree: Worktree;
  target: LandingTarget | null;
  deviceLabel: string;
  landing: Landing;
  toPeer: DestinationPick | undefined;
  pull: PullChoiceState;
}) {
  const { deviceId } = useDestinationScope();
  const icon = useDeviceIcon(deviceId);
  return (
    <EndCard
      heading={heading}
      head={
        <>
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
        </>
      }
      aside={target?.project?.name ?? (target?.clone ? "new checkout" : null)}
      foot={
        target?.project && (
          <SetupRow
            localProject={target.project}
            checked={pull.runSetup}
            onChange={pull.setRunSetup}
          />
        )
      }
    >
      {target === null ? (
        <p className="text-xs text-muted-foreground">No device picked yet.</p>
      ) : target.project ? (
        <LandingLines
          title={title}
          worktree={worktree}
          project={target.project}
          landing={landing}
        />
      ) : (
        <CloneLines clone={target.clone} title={title} worktree={worktree} />
      )}
    </EndCard>
  );
}

// The destination card's last row: whether its create runs the project's
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
    <div className="flex items-center gap-3 border-t border-border px-5 py-3">
      <label
        htmlFor={id}
        className="min-w-0 flex-1 cursor-pointer leading-tight"
      >
        <span className="block text-xs font-medium">Run the setup script</span>
        <SimpleTooltip whenTruncated tip={command}>
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {command}
          </span>
        </SimpleTooltip>
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

// The worktree it becomes in a checkout already there: its
// branch (another name for a primary checkout's copy) and folder name,
// then the whole path, as the source card lays out the original. A
// branch or folder the landing would refuse tints the line, and the
// footer says why.
function LandingLines({
  title,
  worktree,
  project,
  landing,
}: {
  title: string | null;
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
  const path = `${base}/${folder ?? "‹new name›"}`;
  return (
    <>
      <BranchLine
        title={title}
        branch={landingBranch}
        folder={folder ?? "new folder"}
        className={cn(refusal !== null && "text-amber-700 dark:text-amber-300")}
      />
      {base === null ? (
        <Skeleton className="h-3.5 w-2/3" />
      ) : (
        <SimpleTooltip whenTruncated tip={path}>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {path}
          </p>
        </SimpleTooltip>
      )}
    </>
  );
}

// No checkout of the repo there: it lands in a clone made first,
// whose folder can be changed.
function CloneLines({
  clone,
  title,
  worktree,
}: {
  clone: NonNullable<LandingTarget["clone"]>;
  title: string | null;
  worktree: Worktree;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <>
      <BranchLine title={title} branch={worktree.branch} folder={undefined} />
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

// A flow to a peer picks the peer in the destination card's header:
// its name is the menu. A device that cannot take the worktree right
// now is listed, held, with why.
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
        aria-label="Destination device"
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
