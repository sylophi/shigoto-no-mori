// The review step's look, the transplant's and the mirror's, as plain
// views: the two-column layout, the source card, the devices column
// and its rows, the destination folder and the footer band.
// PullReview.tsx reads the devices, the collision and the folder and
// hands them in here, and a scene (lab/scenes) draws them from the
// lab's fixtures.
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import { pullWorktreeName } from "@shared/git/branches";
import type { Project, Worktree } from "@shared/schemas";
import { DeviceGlyph } from "@/components/shared/DeviceGlyph";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip-button";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { FlowBody, FlowFooter } from "./FlowChromeView";
import type { PeerTarget } from "./peerTargets";

// Step 1's layout: the source, what stays out and a flow's own
// sections on the left, the devices column on the right, and the
// footer band under both.
export function PullReviewStepView({
  source,
  beforeLeaveOut,
  leaveOut,
  afterLeaveOut,
  devices,
  footer,
}: {
  // The source card (SourceCardView).
  source: ReactNode;
  beforeLeaveOut?: ReactNode;
  leaveOut: ReactNode;
  afterLeaveOut?: ReactNode;
  // The right-hand column (ReviewDevicesColumnView).
  devices: ReactNode;
  // The footer band (PullReviewFooterView).
  footer: ReactNode;
}) {
  return (
    <>
      <FlowBody>
        <div className="grid gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <section className="space-y-2">
              <SectionHeading>Source</SectionHeading>
              {source}
            </section>

            {beforeLeaveOut}

            {leaveOut}

            {afterLeaveOut}
          </div>

          {devices}
        </div>
      </FlowBody>

      {footer}
    </>
  );
}

// One device of the column: the mark a pick fills, the device, two
// lines about it and a trailing tag. The destination, the devices that
// could be it and the source all wear it.
function DeviceRow({
  className,
  mark,
  icon,
  title,
  note,
  trailing,
  soft = false,
  onPick,
  disabled = false,
}: {
  className: string;
  // The icon and the second line a step back, as the destination's
  // filled row wears them.
  soft?: boolean;
  // Absent on a row that is no pick at all (the source among targets).
  mark?: ReactNode;
  // What the device looks like (DeviceGlyph), never a shape picked here.
  icon: DeviceIcon;
  title: string;
  note: string;
  trailing?: ReactNode;
  // Makes the row a radio to pick the device by.
  onPick?: () => void;
  disabled?: boolean;
}) {
  const body = (
    <>
      {mark}
      <DeviceGlyph icon={icon} className={cn("size-4", soft && "opacity-70")} />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-medium">{title}</span>
        <span className={cn("block truncate text-2xs", soft && "opacity-70")}>
          {note}
        </span>
      </span>
      {trailing}
    </>
  );
  const shape = "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm";
  if (onPick === undefined) {
    return <li className={cn(shape, className)}>{body}</li>;
  }
  return (
    <li>
      <button
        type="button"
        role="radio"
        aria-checked={false}
        disabled={disabled}
        onClick={onPick}
        className={cn(
          shape,
          "w-full text-left transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          className,
        )}
      >
        {body}
      </button>
    </li>
  );
}

const EMPTY_MARK = (
  <span
    aria-hidden
    className="size-4 shrink-0 rounded-full bg-muted-foreground/20"
  />
);

// What the destination row says about the landing device's side of
// the collision check (PullReview.tsx useLocalCollision).
export type DestinationRowCollision = {
  // The branch the copy lands on.
  landingBranch: string;
  held: boolean;
  // The worktree there holding the branch, by name.
  holderName: string | undefined;
};

// The landing device, filled: it has the repo, or gets it (the clone
// the flow makes first, which has no branches to collide with yet).
export function DestinationRowView({
  worktree,
  icon,
  thisDeviceLabel,
  landing,
  collision,
  toPeer,
}: {
  worktree: Worktree;
  icon: DeviceIcon;
  thisDeviceLabel: string;
  // The project the copy lands in there, or the one the clone makes.
  landing: { has: string } | { gets: string };
  collision: DestinationRowCollision;
  // The flow goes to a peer, so the landing device is not this one.
  toPeer: boolean;
}) {
  const holds =
    "has" in landing ? `has ${landing.has}` : `gets ${landing.gets}`;
  const { landingBranch, held, holderName } = collision;
  return (
    <DeviceRow
      className={
        held
          ? "bg-amber-500/10 text-foreground"
          : "bg-accent text-accent-foreground"
      }
      mark={
        <span
          aria-hidden
          className={cn(
            "flex size-4 shrink-0 items-center justify-center rounded-full",
            held
              ? "bg-amber-500 text-background"
              : "bg-primary text-primary-foreground",
          )}
        >
          {held ? (
            <AlertTriangle className="size-2.5" />
          ) : (
            <Check className="size-2.5" />
          )}
        </span>
      }
      icon={icon}
      soft
      title={thisDeviceLabel}
      note={
        held
          ? holderName === undefined
            ? `already has ${landingBranch}`
            : `already has ${landingBranch} in ${holderName}`
          : landingBranch !== worktree.branch
            ? `${holds}, copy on ${landingBranch}`
            : holds
      }
      trailing={
        <StatusDot
          tone={held ? "amber" : "emerald"}
          label={
            <span className="text-xs">
              {toPeer ? "destination" : "this device"}
            </span>
          }
        />
      }
    />
  );
}

// A device that could take the worktree, as the column's row takes it:
// the target (flow/peerTargets.ts) and whether it can take it now.
export type PeerTargetRowData = Pick<
  PeerTarget,
  "deviceId" | "label" | "icon" | "block"
> & {
  project: Pick<Project, "name"> | undefined;
  ready: boolean;
};

// A device that could be the destination and is not (or not yet), as
// the row to pick it by: one with a checkout of the repo, or one that
// would clone it first (named as the destination row names a clone).
// One that cannot take the worktree right now stays listed, off, with
// the reason: a row that vanished would not say why.
function PeerTargetRow({
  target,
  projectName,
  onPick,
}: {
  target: PeerTargetRowData;
  projectName: string;
  onPick: (deviceId: string) => void;
}) {
  return (
    <DeviceRow
      className={cn(
        "bg-muted/40 text-muted-foreground",
        target.ready ? "hover:bg-muted hover:text-foreground" : "opacity-60",
      )}
      mark={EMPTY_MARK}
      icon={target.icon}
      title={target.label}
      note={
        target.project ? `has ${target.project.name}` : `gets ${projectName}`
      }
      trailing={
        target.block !== undefined && (
          <span className="text-xs">
            {target.block === "offline" ? "not connected" : "read-only"}
          </span>
        )
      }
      onPick={() => onPick(target.deviceId)}
      disabled={!target.ready}
    />
  );
}

// The review step's right-hand column, the transplant's and the
// mirror's: the two devices (the one landing the branch, the source
// beneath it), and under them the landing's own sections (the folder
// and the setup switch, or the clone). The mirror ticks the source
// row, because there the source keeps its copy. A flow to a peer swaps
// the two rows' tags (there the source is this device) and lists every
// device that could take the worktree, the picked one as the
// destination and the rest as rows to pick.
export function ReviewDevicesColumnView({
  heading,
  sourceNote,
  sourceKeeps = false,
  toPeer,
  projectName,
  destination,
  sourceIcon,
  sourceDeviceLabel,
  children,
}: {
  heading: string;
  sourceNote: string;
  sourceKeeps?: boolean;
  // A flow to a peer: the devices it could go to and the pick.
  toPeer?: {
    targets: PeerTargetRowData[];
    pickedId: string | null;
    onPick: (deviceId: string) => void;
  };
  // The source's project, for the rows of devices that would clone it.
  projectName: string;
  // The landing device's row (DestinationRowView), null while a flow
  // to a peer has no destination picked.
  destination: ReactNode;
  sourceIcon: DeviceIcon;
  sourceDeviceLabel: string;
  // The landing's sections under the devices.
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <section className="space-y-2">
        <SectionHeading>{heading}</SectionHeading>
        <ul
          className="space-y-1.5"
          role={toPeer ? "radiogroup" : undefined}
          aria-label={toPeer ? "Destination device" : undefined}
        >
          {toPeer === undefined
            ? destination
            : toPeer.targets.map((candidate) =>
                candidate.deviceId === toPeer.pickedId ? (
                  <Fragment key={candidate.deviceId}>{destination}</Fragment>
                ) : (
                  <PeerTargetRow
                    key={candidate.deviceId}
                    target={candidate}
                    projectName={projectName}
                    onPick={toPeer.onPick}
                  />
                ),
              )}
          {/* Among rows to pick from, the source is not one: it sits
              apart, unfilled, and without the mark a pick would
              fill (unless the mark says it keeps its copy). */}
          <DeviceRow
            className={cn(
              "text-muted-foreground",
              toPeer ? "mt-3" : "bg-muted/40",
            )}
            mark={
              (!toPeer || sourceKeeps) && (
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted-foreground/20"
                >
                  {sourceKeeps && <Check className="size-2.5" />}
                </span>
              )
            }
            icon={sourceIcon}
            title={sourceDeviceLabel}
            note={sourceNote}
            trailing={
              <span className="text-xs">
                {toPeer ? "this device" : "source"}
              </span>
            }
          />
        </ul>
      </section>

      {children}
    </div>
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
  // Where the pull would refuse (PullReview.tsx useLocalCollision).
  refusal: string | null;
  // A flow to a peer with no destination picked yet.
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

// The source device's status, as the card's header names it.
export type SourceStatus = { tone: StatusTone; label: string };

export function SourceCardView({
  worktree,
  project,
  sourceDeviceLabel,
  icon,
  status,
  home,
  pr,
  prPending,
}: {
  worktree: Worktree;
  project: Project;
  sourceDeviceLabel: string;
  icon: DeviceIcon;
  // Null where there is none to show (this device).
  status: SourceStatus | null;
  // The source's home, which the path is tildified against, or null
  // to show it as it is.
  home: string | null;
  // The branch's pull request, null when it has none.
  pr: { number: number } | null | undefined;
  prPending: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm">
        <DeviceGlyph icon={icon} className="size-4 text-muted-foreground" />
        <span className="font-medium">{sourceDeviceLabel}</span>
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
          {project.name}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono">
          <span className="text-sm font-semibold">{worktree.branch}</span>
          <span className="text-xs text-muted-foreground">{worktree.name}</span>
        </p>
        <PathSpan
          path={worktree.path}
          home={home}
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
        />
        <div className="flex flex-wrap gap-1.5">
          <Chip
            className="font-mono tabular-nums"
            aria-label={`${worktree.ahead} ahead, ${worktree.behind} behind`}
          >
            <ArrowUp aria-hidden className="size-3" />
            {worktree.ahead}
            <ArrowDown aria-hidden className="ml-0.5 size-3" />
            {worktree.behind}
          </Chip>
          <Chip>
            {worktree.changedCount > 0
              ? pluralize(worktree.changedCount, "uncommitted file")
              : "clean tree"}
          </Chip>
          {!prPending && <Chip>{pr ? `PR #${pr.number}` : "no PR yet"}</Chip>}
        </div>
      </div>
    </div>
  );
}

// Where the worktree lands: the landing layout's base folder plus the
// source's own folder name. The name is left open only when the
// source's folder is not a valid managed dirname, in which case the
// create picks a fresh pool name on arrival.
export function DestinationFolderView({
  thisDeviceLabel,
  base,
  worktree,
}: {
  thisDeviceLabel: string;
  // The base folder as shown (tildified), null until it is read.
  base: string | null;
  // The worktree being pulled, whose folder name the copy takes.
  worktree: Parameters<typeof pullWorktreeName>[0];
}) {
  const name = pullWorktreeName(worktree);
  // Plain text on purpose: a measured PathSpan would abbreviate the
  // base folder to make room for the placeholder beside it.
  const shownName = name ?? "‹new name›";
  return (
    <section className="space-y-2">
      <SectionHeading>Folder on {thisDeviceLabel}</SectionHeading>
      <div className="rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-xs">
        {base === null ? (
          <Skeleton className="h-3.5 w-2/3" />
        ) : (
          <p className="truncate" title={`${base}/${shownName}`}>
            <span className="text-muted-foreground">{base}/</span>
            <span
              className={
                name === undefined ? "text-muted-foreground" : undefined
              }
            >
              {shownName}
            </span>
          </p>
        )}
      </div>
    </section>
  );
}
