// Step 1 of the transplant: what travels, what stays, and where it
// lands. The source half reads the remote device the page is scoped
// to (its diff, its PR, its ignored files). The destination half
// re-pins to this machine (LocalHostScope), because carry-over and the
// folder come from the LOCAL project's config, not the source's, and
// so does the pre-flight: a branch this device already holds fails the
// pull at step 2, so the review says so here and keeps Start off.
import { pullWorktreeName } from "@/lib/remote/pullWorktreeName";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Laptop,
  Monitor,
} from "lucide-react";
import type { Project, Worktree } from "@shared/schemas";
import {
  pullBranchCollision,
  pullFolderCollision,
} from "@shared/pullCollision";
import { worktreeBaseFor } from "@shared/git/worktreeLayout";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip-button";
import { DiffStats } from "@/components/ui/diff-stats";
import { PathSpan } from "@/components/ui/path-span";
import { RowTag } from "@/components/ui/row-tag";
import { SectionHeading } from "@/components/ui/section-heading";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { changeEntries } from "@/components/diff/patchFiles";
import { useShigomoriConfig } from "@/hooks/config/useShigomoriConfig";
import { useBranches } from "@/hooks/git/useBranches";
import { LocalHostScope, useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useWorktreeChanges } from "@/hooks/worktrees/useWorktreeChanges";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { tildify } from "@/lib/projectPaths";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { cn } from "@/lib/utils";
import type { PullChoiceState } from "../mirror/ignoreChoice";
import { MirrorIgnorePicker } from "../mirror/MirrorIgnorePicker";
import { useCarryOverRows } from "./createPlan";
import { SetupToggle } from "./SetupToggle";
import {
  CARD_NOTE,
  CardList,
  CardSkeleton,
  MAX_LIST_ROWS as MAX_ROWS,
  TransplantBody,
  TransplantFooter,
} from "./TransplantChrome";

export function TransplantReview({
  worktree,
  project,
  localProject,
  sourceDeviceLabel,
  thisDeviceLabel,
  pull,
  onCancel,
  onStart,
}: {
  worktree: Worktree;
  project: Project;
  localProject: Project;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
  // The leave-out rule and the setup switch, the mirror's pair.
  pull: PullChoiceState;
  onCancel: () => void;
  onStart: () => void;
}) {
  const dirty = worktree.changedCount > 0;
  return (
    <>
      <TransplantBody>
        <div className="grid gap-5 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <section className="space-y-2">
              <SectionHeading>Source</SectionHeading>
              <SourceCard
                worktree={worktree}
                project={project}
                sourceDeviceLabel={sourceDeviceLabel}
              />
            </section>

            <section className="space-y-2">
              <SectionHeading>
                Uncommitted changes
                <span className="ml-1.5 font-normal tracking-normal normal-case">
                  {dirty ? "(re-applied on arrival)" : "(none)"}
                </span>
              </SectionHeading>
              {dirty ? (
                <ChangedFiles worktree={worktree} project={project} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  The tree is clean, so only the branch travels.
                </p>
              )}
            </section>

            <MirrorIgnorePicker
              value={pull.selection}
              onChange={pull.setSelection}
              ignored={pull.ignored}
              worktree={{
                projectId: project.id,
                id: worktree.id,
                path: worktree.path,
              }}
            />

            <LocalHostScope>
              <CarryOverList
                localProject={localProject}
                thisDeviceLabel={thisDeviceLabel}
              />
            </LocalHostScope>
          </div>

          <LocalHostScope>
            <div className="flex min-w-0 flex-col gap-5">
              <section className="space-y-2">
                <SectionHeading>Destination</SectionHeading>
                <ul className="space-y-1.5">
                  <DestinationRow
                    worktree={worktree}
                    localProject={localProject}
                    thisDeviceLabel={thisDeviceLabel}
                  />
                  <li className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
                    <span
                      aria-hidden
                      className="size-4 shrink-0 rounded-full bg-muted-foreground/20"
                    />
                    <Monitor aria-hidden className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate font-medium">
                        {sourceDeviceLabel}
                      </span>
                      <span className="block truncate text-[11px]">
                        where it is now
                      </span>
                    </span>
                    <span className="text-xs">source</span>
                  </li>
                </ul>
              </section>

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
            </div>
          </LocalHostScope>
        </div>
      </TransplantBody>

      <LocalHostScope>
        <PullReviewFooter
          worktree={worktree}
          localProject={localProject}
          waiting={pull.waiting}
          blocked={pull.blocked}
          idleNote={`Nothing on ${sourceDeviceLabel} is deleted until you say so at the last step.`}
          startLabel="Start transplant"
          onCancel={onCancel}
          onStart={onStart}
        />
      </LocalHostScope>
    </>
  );
}

// Where the pull would refuse at step 2 (host/ipc/modules/sync.ts
// runPullWorktree): this device already has the branch, checked out
// in a worktree or merely existing, or already has a worktree under
// the folder name the copy would take. Read under LocalHostScope. Both
// lists are the ordinary cached ones, so the row and the footer
// asking the same question cost one read between them. The disk half
// of the folder rule (a stray folder that is no worktree) is the
// host's alone.
export function useLocalCollision(
  localProject: Project,
  worktree: Worktree,
): {
  held: boolean;
  holder: Worktree | undefined;
  // The refusal the footer shows and Start waits on, or null.
  refusal: string | null;
} {
  const { data: branches } = useBranches(localProject.id);
  const { data: worktrees } = useWorktrees(localProject.id);
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
  const refusal = held
    ? pullBranchCollision(worktree.branch, holder?.path)
    : taken
      ? pullFolderCollision(name, `${localProject.name}/${name}`)
      : null;
  return { held, holder, refusal };
}

export function DestinationRow({
  worktree,
  localProject,
  thisDeviceLabel,
}: {
  worktree: Worktree;
  localProject: Project;
  thisDeviceLabel: string;
}) {
  const { held, holder } = useLocalCollision(localProject, worktree);
  return (
    <li
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm",
        held
          ? "bg-amber-500/10 text-foreground"
          : "bg-accent text-accent-foreground",
      )}
    >
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
      <Laptop aria-hidden className="size-4 shrink-0 opacity-70" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-medium">{thisDeviceLabel}</span>
        <span className="block truncate text-[11px] opacity-70">
          {held
            ? holder === undefined
              ? `already has ${worktree.branch}`
              : `already has ${worktree.branch} in ${holder.name}`
            : `has ${localProject.name}`}
        </span>
      </span>
      <StatusDot
        tone={held ? "amber" : "emerald"}
        label={<span className="text-xs">this device</span>}
      />
    </li>
  );
}

// The review step's footer band, the transplant's and the mirror's:
// the collision refusal or the wait's reason when there is one, the
// flow's own reassurance when there is not, and the start button held
// until both clear.
export function PullReviewFooter({
  worktree,
  localProject,
  waiting,
  blocked,
  idleNote,
  startLabel,
  onCancel,
  onStart,
}: {
  worktree: Worktree;
  localProject: Project;
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
  const { refusal } = useLocalCollision(localProject, worktree);
  return (
    <TransplantFooter note={refusal ?? blocked ?? idleNote}>
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button
        size="sm"
        onClick={onStart}
        disabled={refusal !== null || waiting}
      >
        {startLabel}
        <ArrowRight />
      </Button>
    </TransplantFooter>
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
        <Monitor
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
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

function ChangedFiles({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  // A one-shot preview: the list crosses the device link, so it is not
  // re-pulled on every focus the way the changes page's is. It is git
  // status rather than a patch, so untracked files are listed too.
  const {
    data: changed,
    isPending,
    isError,
  } = useWorktreeChanges(project.id, worktree.id, {
    refetchOnWindowFocus: false,
  });
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

// The local project's carry-over (createPlan.ts), as the review's
// card. Under LocalHostScope by the caller.
function CarryOverList({
  localProject,
  thisDeviceLabel,
}: {
  localProject: Project;
  thisDeviceLabel: string;
}) {
  const { rows, isPending } = useCarryOverRows(localProject);
  return (
    <section className="space-y-2">
      <SectionHeading>
        Carry-over files
        <span className="ml-1.5 font-normal tracking-normal normal-case">
          (from {localProject.name} on {thisDeviceLabel})
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

// Where the worktree lands: the local layout's base folder plus the
// source's own folder name (pullWorktreeName). The name is left open
// only when the source's folder is not a valid managed dirname, in
// which case the create picks a fresh pool name on arrival.
export function DestinationFolder({
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
