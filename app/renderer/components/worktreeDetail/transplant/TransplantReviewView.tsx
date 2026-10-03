// Step 1 of the transplant as plain views: the uncommitted changes
// that travel, the landing project's carry-over, and the whole review
// (TransplantReviewView) composed from the flow's review views with
// every fact handed in. TransplantReview.tsx reads them for the live
// dialog, and a scene (lab/scenes) builds them from the lab's fixtures.
import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { pullWorktreeName } from "@shared/git/branches";
import type { IgnoreSelection } from "@shared/leaveOutRule";
import type { ChangedFile, Project, Worktree } from "@shared/schemas";
import type { DeviceIcon } from "@shared/account/deviceIcon";
import { DiffStats } from "@/components/ui/diff-stats";
import { RowTag } from "@/components/ui/row-tag";
import { SectionHeading } from "@/components/ui/section-heading";
import { changeEntries } from "@/lib/patchFiles";
import { cn } from "@/lib/utils";
import {
  CARD_NOTE,
  CardList,
  CardSkeleton,
  MAX_LIST_ROWS as MAX_ROWS,
} from "../flow/FlowChromeView";
import type { IgnoredPathsState } from "../flow/LeaveOutPickerView";
import { PullLeaveOutView } from "../flow/PullLeaveOutView";
import {
  DestinationFolderView,
  type DestinationRowCollision,
  DestinationRowView,
  type PeerTargetRowData,
  PullReviewFooterView,
  PullReviewStepView,
  ReviewDevicesColumnView,
  SourceCardView,
  type SourceStatus,
} from "../flow/PullReviewView";
import { SetupToggleView } from "../flow/SetupToggleView";

// The section over the changes: what the tree holds, and the list of
// it (ChangedFilesView) when it is dirty.
export function UncommittedChangesView({
  dirty,
  children,
}: {
  dirty: boolean;
  // The list, for a dirty tree.
  children?: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <SectionHeading>
        Uncommitted changes
        <span className="ml-1.5 font-normal tracking-normal normal-case">
          {dirty ? "(re-applied on arrival)" : "(none)"}
        </span>
      </SectionHeading>
      {dirty ? (
        children
      ) : (
        <p className="text-xs text-muted-foreground">
          The tree is clean, so only the branch travels.
        </p>
      )}
    </section>
  );
}

// The source's changes as git status reads them.
export type ChangedFilesState = {
  changed: readonly ChangedFile[] | undefined;
  isPending: boolean;
  isError: boolean;
};

export function ChangedFilesView({
  changed,
  isPending,
  isError,
}: ChangedFilesState) {
  if (isPending) return <CardSkeleton rows={2} />;
  if (isError) {
    return (
      <p className={CARD_NOTE}>
        The diff could not be read right now. The changes travel all the same.
      </p>
    );
  }
  const files = changeEntries(changed ?? []);
  if (files.length === 0) {
    return <p className={CARD_NOTE}>No uncommitted changes to list.</p>;
  }
  return (
    <CardList total={files.length}>
      {files.slice(0, MAX_ROWS).map((entry) => {
        const { mark, stats } = entry;
        return (
          <li key={entry.key} className="flex items-center gap-2">
            <span
              aria-label={mark.label}
              className={cn("w-3 shrink-0 font-semibold", mark.className)}
            >
              {mark.mark}
            </span>
            <span className="min-w-0 flex-1 truncate" title={entry.path}>
              {entry.path}
            </span>
            {stats && (
              <DiffStats
                additions={stats.additions}
                deletions={stats.deletions}
              />
            )}
          </li>
        );
      })}
    </CardList>
  );
}

// One carry-over entry and how it travels (copy, symlink, include).
export type CarryOverRow = { path: string; tag: string };

// The landing project's carry-over (../flow/createPlan.ts), as the
// review's card.
export function CarryOverListView({
  projectName,
  thisDeviceLabel,
  rows,
  isPending,
}: {
  // The landing project's name.
  projectName: string;
  thisDeviceLabel: string;
  rows: readonly CarryOverRow[];
  isPending: boolean;
}) {
  return (
    <section className="space-y-2">
      <SectionHeading>
        Carry-over files
        <span className="ml-1.5 font-normal tracking-normal normal-case">
          (from {projectName} on {thisDeviceLabel})
        </span>
      </SectionHeading>
      {isPending ? (
        <CardSkeleton />
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">None configured.</p>
      ) : (
        <CardList total={rows.length}>
          {rows.slice(0, MAX_ROWS).map((row) => (
            <li key={row.path} className="flex items-center gap-2">
              <Check
                aria-hidden
                className="size-3 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate" title={row.path}>
                {row.path}
              </span>
              <RowTag>{row.tag}</RowTag>
            </li>
          ))}
        </CardList>
      )}
    </section>
  );
}

// The transplant's words around the flow's review.
export const TRANSPLANT_REVIEW = {
  heading: "Destination",
  sourceNote: "where it is now",
  startLabel: "Start transplant",
  idleNote: (sourceDeviceLabel: string) =>
    `Nothing on ${sourceDeviceLabel} is deleted until you say so at the last step.`,
};

// Everything the review shows, as data. A landing into a checkout the
// destination already holds: the clone a destination without one gets
// is the live dialog's alone (flow/cloneDestination.tsx).
export type TransplantReviewViewProps = {
  worktree: Worktree;
  project: Project;
  sourceDeviceLabel: string;
  // The landing device's name.
  thisDeviceLabel: string;
  // The source device, as the card's header shows it.
  source: {
    icon: DeviceIcon;
    status: SourceStatus | null;
    // The source's home, for the tildified path.
    home: string | null;
    pr: { number: number } | null | undefined;
    prPending: boolean;
  };
  // The listed changes, for a dirty tree.
  changes?: ChangedFilesState;
  leaveOut: {
    selection: IgnoreSelection;
    ignored: IgnoredPathsState;
    presetDiffers: boolean;
  };
  // The landing project, null while a flow to a peer has none picked.
  destination: {
    project: Project;
    icon: DeviceIcon;
    collision: DestinationRowCollision;
    carryOver: { rows: readonly CarryOverRow[]; isPending: boolean };
    // The folder's base as shown (tildified), null until it is read.
    folderBase: string | null;
    // The landing project's setup command, "" when none.
    setupCommand: string;
  } | null;
  sourceIcon: DeviceIcon;
  // A flow to a peer: the devices it could go to and the pick.
  toPeer?: { targets: PeerTargetRowData[]; pickedId: string | null };
  runSetup: boolean;
  footer: { refusal: string | null; waiting: boolean; blocked: string | null };
  onSelectionChange?: (next: IgnoreSelection) => void;
  onAddLeaveOut?: () => void;
  onSaveAsPreset?: () => void;
  onPick?: (deviceId: string) => void;
  onRunSetupChange?: (next: boolean) => void;
  onCancel?: () => void;
  onStart?: () => void;
};

const noop = () => {};

export function TransplantReviewView({
  worktree,
  project,
  sourceDeviceLabel,
  thisDeviceLabel,
  source,
  changes,
  leaveOut,
  destination,
  sourceIcon,
  toPeer,
  runSetup,
  footer,
  onSelectionChange = noop,
  onAddLeaveOut = noop,
  onSaveAsPreset = noop,
  onPick = noop,
  onRunSetupChange = noop,
  onCancel = noop,
  onStart = noop,
}: TransplantReviewViewProps) {
  const dirty = worktree.changedCount > 0;
  return (
    <PullReviewStepView
      source={
        <SourceCardView
          worktree={worktree}
          project={project}
          sourceDeviceLabel={sourceDeviceLabel}
          {...source}
        />
      }
      beforeLeaveOut={
        <UncommittedChangesView dirty={dirty}>
          {changes && <ChangedFilesView {...changes} />}
        </UncommittedChangesView>
      }
      leaveOut={
        <PullLeaveOutView
          selection={leaveOut.selection}
          onChange={onSelectionChange}
          ignored={leaveOut.ignored}
          presetDiffers={leaveOut.presetDiffers}
          onSaveAsPreset={onSaveAsPreset}
          onAdd={onAddLeaveOut}
        />
      }
      afterLeaveOut={
        destination && (
          <CarryOverListView
            projectName={destination.project.name}
            thisDeviceLabel={thisDeviceLabel}
            {...destination.carryOver}
          />
        )
      }
      devices={
        <ReviewDevicesColumnView
          heading={TRANSPLANT_REVIEW.heading}
          sourceNote={TRANSPLANT_REVIEW.sourceNote}
          toPeer={toPeer && { ...toPeer, onPick }}
          projectName={project.name}
          destination={
            destination && (
              <DestinationRowView
                worktree={worktree}
                icon={destination.icon}
                thisDeviceLabel={thisDeviceLabel}
                holds={`has ${destination.project.name}`}
                collision={destination.collision}
                tag={toPeer ? "destination" : "this device"}
              />
            )
          }
          sourceIcon={sourceIcon}
          sourceDeviceLabel={sourceDeviceLabel}
        >
          {destination && (
            <>
              <DestinationFolderView
                thisDeviceLabel={thisDeviceLabel}
                base={destination.folderBase}
                name={pullWorktreeName(worktree)}
              />
              <SetupToggleView
                thisDeviceLabel={thisDeviceLabel}
                command={destination.setupCommand}
                checked={runSetup}
                onChange={onRunSetupChange}
              />
            </>
          )}
        </ReviewDevicesColumnView>
      }
      footer={
        <PullReviewFooterView
          {...footer}
          unpicked={destination === null}
          idleNote={TRANSPLANT_REVIEW.idleNote(sourceDeviceLabel)}
          startLabel={TRANSPLANT_REVIEW.startLabel}
          onCancel={onCancel}
          onStart={onStart}
        />
      }
    />
  );
}
