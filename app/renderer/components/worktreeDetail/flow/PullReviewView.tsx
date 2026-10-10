// The review step's parts, drawn (PullReview.tsx binds them): the pair
// card with its two ends, the setup switch, the landing and clone
// lines, the pick of a peer, and the footer band.
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
import { type ReactNode, useId } from "react";
import type { DeviceIcon } from "@shigomori/contracts/deviceIcon";
import type { PullRequestDetail, Worktree } from "@shigomori/contracts/schemas";
import { DeviceGlyphView } from "@shigomori/ui/views/shared/DeviceGlyphView.tsx";
import { Button } from "@shigomori/ui/primitives/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { PathSpan } from "@shigomori/ui/primitives/path-span.tsx";
import { SectionHeading } from "@shigomori/ui/primitives/section-heading.tsx";
import { Skeleton } from "@shigomori/ui/primitives/skeleton.tsx";
import { Switch } from "@shigomori/ui/primitives/switch.tsx";
import { SimpleTooltip } from "@shigomori/ui/primitives/tooltip.tsx";
import { cn } from "@shigomori/ui/lib/utils.ts";
import type { LandingTarget } from "./cloneDestination";
import { FlowBodyView, FlowFooterView } from "./FlowChromeView";
import type { DeviceTarget } from "@/components/shared/deviceTargets";
import type { HostApi } from "@/hooks/remote/useHostScope";

// A peer that could take the worktree, with its checkout of the repo
// when it has one. Its `block` says why it cannot take the worktree
// right now (asleep, or not granting this device control).
export type PeerTarget = DeviceTarget & {
  block: "offline" | "no-grant" | undefined;
};
export type ReadyPeerTarget = PeerTarget & { api: HostApi };

export function isReadyTarget(target: PeerTarget): target is ReadyPeerTarget {
  return target.block === undefined && target.api !== undefined;
}

// The destination's pick, for a flow to a peer: the devices that could
// take the worktree and the way to choose which one does (the
// destination card's header). Until one is picked there is no landing
// project, so the card asks for the pick and Start waits.
export type DestinationPick = {
  targets: PeerTarget[];
  pickedId: string | null;
  onPick: (deviceId: string) => void;
};

// Step 1 of either flow, in two parts. The pair first, on a band of
// its own: the source card and the destination card side by side,
// joined by what the flow does between them (a move, or a mirror kept
// in step both ways), both the same height, so the two ends read as
// one thing. Then the options, on the page below the band: what stays
// out and a flow's own sections (`details`: the transplant's changes
// and carry-over), in a grid of their own.
export function PullReviewStepView({
  link,
  source,
  destination,
  leaveOut,
  details,
  footer,
}: {
  // What joins the two ends: a move one way, or a mirror both ways.
  link: "move" | "mirror";
  source: ReactNode;
  destination: ReactNode;
  leaveOut: ReactNode;
  // A flow's own sections, beside what stays out under the pair.
  details?: ReactNode;
  footer: ReactNode;
}) {
  const Link = link === "mirror" ? ArrowLeftRight : ArrowRight;
  return (
    <>
      <FlowBodyView>
        <div className="flex flex-col gap-6">
          <div className="relative grid overflow-hidden rounded-xl border border-border bg-card md:grid-cols-2">
            {source}
            {destination}
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
            {leaveOut}
            {details !== undefined && (
              <div className="flex min-w-0 flex-col gap-6">{details}</div>
            )}
          </div>
        </div>
      </FlowBodyView>
      {footer}
    </>
  );
}

// The review step's footer band, the transplant's and the mirror's:
// the collision refusal or the wait's reason when there is one, the
// flow's own reassurance when there is not, and the start button held
// until both clear. A flow to a peer with no destination picked yet
// has nothing to check, and the band asks for the pick.
export function PullReviewFooterView({
  refusal,
  unpicked,
  waiting,
  blocked,
  idleNote,
  startLabel,
  onCancel,
  onStart,
}: {
  // The collision the landing would refuse on, or null.
  refusal: string | null;
  unpicked: boolean;
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
  return (
    <FlowFooterView
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
    </FlowFooterView>
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

export function SourceCardView({
  heading,
  title,
  pr,
  worktree,
  projectName,
  sourceDeviceLabel,
  icon,
  home,
}: {
  heading: string;
  title: string | null;
  pr: PullRequestDetail | null | undefined;
  worktree: Worktree;
  projectName: string;
  sourceDeviceLabel: string;
  icon: DeviceIcon;
  // The source device's home, null while unknown: the path shows as
  // it is.
  home: string | null;
}) {
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
          <DeviceGlyphView
            icon={icon}
            className="size-4 text-muted-foreground"
          />
          <span className="font-medium">{sourceDeviceLabel}</span>
        </>
      }
      aside={projectName}
    >
      <BranchLine
        title={title}
        branch={worktree.branch}
        folder={worktree.name}
      />
      <PathSpan
        path={worktree.path}
        home={home}
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
export function DestinationCardView({
  heading,
  icon,
  deviceLabel,
  target,
  toPeer,
  setup,
  lines,
}: {
  heading: string;
  icon: DeviceIcon;
  deviceLabel: string;
  target: LandingTarget | null;
  toPeer: DestinationPick | undefined;
  // The setup switch, under a landing project.
  setup: ReactNode;
  // The worktree it becomes, once a target is picked.
  lines: ReactNode;
}) {
  return (
    <EndCard
      heading={heading}
      head={
        <>
          <DeviceGlyphView
            icon={icon}
            className="size-4 text-muted-foreground"
          />
          {toPeer ? (
            <DevicePickView
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
      foot={setup}
    >
      {target === null ? (
        <p className="text-xs text-muted-foreground">No device picked yet.</p>
      ) : (
        lines
      )}
    </EndCard>
  );
}

// The destination card's last row: whether its create runs the project's
// setup script there. A project without one has no row.
export function SetupRowView({
  command,
  checked,
  onChange,
}: {
  command: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
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
export function LandingLinesView({
  title,
  landingBranch,
  folder,
  refused,
  base,
}: {
  title: string | null;
  landingBranch: string;
  folder: string | undefined;
  refused: boolean;
  // Where the project's worktrees go there, null while unknown.
  base: string | null;
}) {
  const path = `${base}/${folder ?? "‹new name›"}`;
  return (
    <>
      <BranchLine
        title={title}
        branch={landingBranch}
        folder={folder ?? "new folder"}
        className={cn(refused && "text-amber-700 dark:text-amber-300")}
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
export function CloneLinesView({
  clone,
  title,
  worktree,
  onChange,
  picker,
}: {
  clone: NonNullable<LandingTarget["clone"]>;
  title: string | null;
  worktree: Worktree;
  // Opens the folder picker, drawn in `picker` while it is up.
  onChange: () => void;
  picker: ReactNode;
}) {
  return (
    <>
      <BranchLine title={title} branch={worktree.branch} folder={undefined} />
      <div className="flex items-center gap-2">
        <PathSpan
          path={clone.dest}
          home={null}
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        />
        <Button variant="outline" size="xs" onClick={onChange}>
          Change
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        No checkout of {clone.projectName} there yet, so it&rsquo;s cloned
        first.
      </p>
      {picker}
    </>
  );
}

// A flow to a peer picks the peer in the destination card's header:
// its name is the menu. A device that cannot take the worktree right
// now is listed, held, with why.
export function DevicePickView({
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
              <DeviceGlyphView
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
