// The review step's pieces the transplant and the mirror both wear: the
// source card, the devices column, the destination folder, the
// collision check and the footer band. Each flow's own review composes
// them around what only it shows. The destination is this machine
// unless the flow is a transplant to a peer (DestinationScope), so
// `localProject` and `thisDeviceLabel` name the landing side, whichever
// machine that is.
import { pullWorktreeName } from "@shared/git/branches";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Laptop,
  type LucideIcon,
  Monitor,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { Project, Worktree } from "@shared/schemas";
import {
  pullBranchCollision,
  pullFolderCollision,
} from "@shared/pullCollision";
import { worktreeBaseFor } from "@shared/git/worktreeLayout";
import { DeviceIcon } from "@/components/shared/DeviceIcon";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip-button";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useBranches } from "@/hooks/git/useBranches";
import { DestinationScope, useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { tildify } from "@/lib/projectPaths";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { cn } from "@/lib/utils";
import type { PullChoiceState } from "./ignoreChoice";
import { SetupToggle } from "./SetupToggle";
import { FlowFooter } from "./FlowChrome";
import { isReadyTarget, type PeerTarget } from "./peerTargets";
import { type Landing, LANDS_HERE } from "./pullSteps";

// The destination's pick, for a flow to a peer: the devices that could
// take the worktree and the way to choose which one does. The picked
// one is the destination the rest of the column describes. Until one
// is picked there is no landing project, so the column is the rows
// alone and the footer holds Start.
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
// to a peer before its pick) nothing is read and nothing refuses.
function useLocalCollision(
  localProject: Project | undefined,
  worktree: Worktree,
  landing: Landing = LANDS_HERE,
): {
  held: boolean;
  holder: Worktree | undefined;
  // The refusal the footer shows and Start waits on, or null.
  refusal: string | null;
} {
  const { data: branches } = useBranches(localProject?.id ?? null);
  const { data: worktrees } = useWorktrees(localProject?.id ?? null);
  const held = branches?.local.includes(worktree.branch) ?? false;
  const holder = held
    ? worktrees?.find((entry) => entry.branch === worktree.branch)
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
        ? pullBranchCollision(worktree.branch, holder?.path, where)
        : taken
          ? pullFolderCollision(name, `${localProject.name}/${name}`, where)
          : null;
  return { held, holder, refusal };
}

// One device of the column: the mark a pick fills, the device, two
// lines about it and a trailing tag. The destination, the devices that
// could be it and the source all wear it.
function DeviceRow({
  className,
  mark,
  icon: Icon,
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
  icon: LucideIcon;
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
      <Icon
        aria-hidden
        className={cn("size-4 shrink-0", soft && "opacity-70")}
      />
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

function DestinationRow({
  worktree,
  localProject,
  thisDeviceLabel,
  tag,
}: {
  worktree: Worktree;
  localProject: Project;
  thisDeviceLabel: string;
  tag: string;
}) {
  const { held, holder } = useLocalCollision(localProject, worktree);
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
      icon={Laptop}
      soft
      title={thisDeviceLabel}
      note={
        held
          ? holder === undefined
            ? `already has ${worktree.branch}`
            : `already has ${worktree.branch} in ${holder.name}`
          : `has ${localProject.name}`
      }
      trailing={
        <StatusDot
          tone={held ? "amber" : "emerald"}
          label={<span className="text-xs">{tag}</span>}
        />
      }
    />
  );
}

// A device that could be the destination and is not (or not yet), as
// the row to pick it by. One that cannot take the worktree right now
// stays listed, off, with the reason: a row that vanished would not
// say why.
function PeerTargetRow({
  target,
  onPick,
}: {
  target: PeerTarget;
  onPick: (deviceId: string) => void;
}) {
  const ready = isReadyTarget(target);
  return (
    <DeviceRow
      className={cn(
        "bg-muted/40 text-muted-foreground",
        ready ? "hover:bg-muted hover:text-foreground" : "opacity-60",
      )}
      mark={EMPTY_MARK}
      icon={Monitor}
      title={target.label}
      note={`has ${target.project.name}`}
      trailing={
        target.block !== undefined && (
          <span className="text-xs">
            {target.block === "offline" ? "not connected" : "read-only"}
          </span>
        )
      }
      onPick={() => onPick(target.deviceId)}
      disabled={!ready}
    />
  );
}

// The review step's right-hand column, the transplant's and the
// mirror's: the two devices (the one landing the branch, the source
// beneath it), the folder it lands in, and the setup switch. Read under
// the destination's scope, since every fact in it is that machine's.
// The mirror ticks the source row, because there the source keeps its
// copy. A flow to a peer swaps the two rows' tags (there the source is
// this device) and lists every device that could take the worktree,
// the picked one as the destination and the rest as rows to pick.
export function ReviewDevicesColumn({
  heading,
  sourceNote,
  sourceKeeps = false,
  toPeer,
  worktree,
  localProject,
  sourceDeviceLabel,
  thisDeviceLabel,
  pull,
}: {
  heading: string;
  sourceNote: string;
  sourceKeeps?: boolean;
  toPeer?: DestinationPick;
  worktree: Worktree;
  // Absent while a flow to a peer has no destination picked.
  localProject: Project | undefined;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  pull: PullChoiceState;
}) {
  const destination = localProject !== undefined && (
    <DestinationRow
      worktree={worktree}
      localProject={localProject}
      thisDeviceLabel={thisDeviceLabel}
      tag={toPeer ? "destination" : "this device"}
    />
  );
  return (
    <DestinationScope>
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
              : toPeer.targets.map((target) =>
                  target.deviceId === toPeer.pickedId ? (
                    <Fragment key={target.deviceId}>{destination}</Fragment>
                  ) : (
                    <PeerTargetRow
                      key={target.deviceId}
                      target={target}
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
              icon={Monitor}
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

        {localProject !== undefined && (
          <>
            <DestinationFolder
              localProject={localProject}
              thisDeviceLabel={thisDeviceLabel}
              name={pullWorktreeName(worktree)}
            />

            <SetupToggle
              localProject={localProject}
              thisDeviceLabel={thisDeviceLabel}
              checked={pull.runSetup}
              onChange={pull.setRunSetup}
              pinned={pull.setupPinned}
            />
          </>
        )}
      </div>
    </DestinationScope>
  );
}

// The review step's footer band, the transplant's and the mirror's:
// the collision refusal or the wait's reason when there is one, the
// flow's own reassurance when there is not, and the start button held
// until both clear. A flow to a peer with no destination picked yet
// has nothing to check, and the band asks for the pick.
export function PullReviewFooter({
  worktree,
  localProject,
  landing,
  waiting,
  blocked,
  idleNote,
  startLabel,
  onCancel,
  onStart,
}: {
  worktree: Worktree;
  localProject: Project | undefined;
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
  const { refusal } = useLocalCollision(localProject, worktree, landing);
  const unpicked = localProject === undefined;
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

export function SourceCard({
  worktree,
  project,
  sourceDeviceLabel,
}: {
  worktree: Worktree;
  project: Project;
  sourceDeviceLabel: string;
}) {
  const { deviceId } = useHostScope();
  const device = useRemoteDevice(deviceId);
  const status = device ? deviceStatusView(device.status) : null;
  // The card sits in the source device's scope, so this is the PEER's
  // home, and a transplant already holds the grant that read needs.
  // Refused or not yet answered, the path shows as it is.
  const { data: runtime } = useRuntimeInfo();
  const { data: pr, isPending: prPending } = useWorktreePullRequest(
    project.id,
    worktree.branch,
  );
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-sm">
        <DeviceIcon
          kind={device?.kind ?? "desktop"}
          className="size-4 text-muted-foreground"
        />
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
          home={runtime?.homedir ?? null}
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
              ? `${worktree.changedCount} uncommitted ${
                  worktree.changedCount === 1 ? "file" : "files"
                }`
              : "clean tree"}
          </Chip>
          {!prPending && <Chip>{pr ? `PR #${pr.number}` : "no PR yet"}</Chip>}
        </div>
      </div>
    </div>
  );
}

// Where the worktree lands: the local layout's base folder plus the
// source's own folder name (pullWorktreeName). The name is left open
// only when the source's folder is not a valid managed dirname, in
// which case the create picks a fresh pool name on arrival.
function DestinationFolder({
  localProject,
  thisDeviceLabel,
  name,
}: {
  localProject: Project;
  thisDeviceLabel: string;
  name: string | undefined;
}) {
  const { data: config } = useShigomoriConfig(localProject.id);
  const { data: runtime } = useRuntimeInfo();
  // Plain text on purpose: a measured PathSpan would abbreviate the
  // base folder to make room for the placeholder beside it.
  const base = runtime
    ? tildify(
        worktreeBaseFor({
          layout: config?.worktreeLayout ?? "managed-root",
          projectPath: localProject.path,
          dataDir: runtime.dataDir,
          customPath: config?.customWorktreePath ?? null,
        }),
        runtime.homedir,
      )
    : null;
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
