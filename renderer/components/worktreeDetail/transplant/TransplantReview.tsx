// Step 1 of the transplant: what travels, what stays, and where it
// lands. The source half reads the remote device the page is scoped
// to (its diff, its PR, its ignored files). The destination half
// re-pins to this machine (LocalHostScope), because carry-over and the
// folder come from the LOCAL project's config, not the source's, and
// so does the pre-flight: a branch this device already holds fails the
// pull at step 2, so the review says so here and keeps Start off.
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Laptop,
  Monitor,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Project, Worktree } from "@shared/schemas";
import { pullBranchCollision } from "@shared/pullCollision";
import { worktreeBaseFor } from "@shared/worktreeLayout";
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
import { worktreeIncludeExtras } from "@/hooks/projects/carryOverPaths";
import { useWorktreeIncludeStatus } from "@/hooks/projects/useWorktreeIncludeStatus";
import { LocalHostScope, useHostScope } from "@/hooks/remote/useHostScope";
import { useRemoteDevice } from "@/hooks/remote/useRemoteDevices";
import { useWorktreeIgnoredPaths } from "@/hooks/remote/useWorktreeIgnoredPaths";
import { useRuntimeInfo } from "@/hooks/system/useRuntimeInfo";
import { useWorktreeChanges } from "@/hooks/worktrees/useWorktreeChanges";
import { useWorktrees } from "@/hooks/worktrees/useWorktrees";
import { useWorktreePullRequest } from "@/hooks/worktrees/useWorktreePullRequest";
import { tildify } from "@/lib/projectPaths";
import { deviceStatusView } from "@/lib/remote/deviceStatus";
import { cn } from "@/lib/utils";
import { NoteBox, TransplantBody, TransplantFooter } from "./TransplantChrome";

const MAX_ROWS = 8;

// The review's three file lists (changed, staying behind, carry-over)
// share one card: a bordered monospace list showing the first MAX_ROWS
// entries and counting the rest.
const CARD = "rounded-lg border border-border bg-card p-3";
const CARD_NOTE = `${CARD} text-xs text-muted-foreground`;

function CardList({ total, children }: { total: number; children: ReactNode }) {
  return (
    <ul className={`${CARD} space-y-1 font-mono text-xs`}>
      {children}
      {total > MAX_ROWS && (
        <li className="text-muted-foreground">and {total - MAX_ROWS} more</li>
      )}
    </ul>
  );
}

function CardSkeleton({ rows = 1 }: { rows?: 1 | 2 }) {
  return (
    <div className={`${CARD} space-y-1.5`}>
      {rows === 2 && <Skeleton className="h-3.5 w-3/4" />}
      <Skeleton className="h-3.5 w-1/2" />
    </div>
  );
}

export function TransplantReview({
  worktree,
  project,
  localProject,
  sourceDeviceLabel,
  thisDeviceLabel,
  onCancel,
  onStart,
}: {
  worktree: Worktree;
  project: Project;
  localProject: Project;
  sourceDeviceLabel: string;
  thisDeviceLabel: string;
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

            <StaysBehind
              worktree={worktree}
              project={project}
              localProject={localProject}
              sourceDeviceLabel={sourceDeviceLabel}
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
              />

              <NoteBox title="What happens">
                <ol className="list-decimal space-y-1 pl-4">
                  <li>{sourceDeviceLabel} captures the uncommitted changes.</li>
                  <li>Branch and changes cross the device link directly.</li>
                  <li>
                    {thisDeviceLabel} creates the worktree, runs carry-over and
                    setup{dirty ? ", then re-applies your edits." : "."}
                  </li>
                </ol>
              </NoteBox>
            </div>
          </LocalHostScope>
        </div>
      </TransplantBody>

      <LocalHostScope>
        <ReviewFooter
          worktree={worktree}
          localProject={localProject}
          sourceDeviceLabel={sourceDeviceLabel}
          onCancel={onCancel}
          onStart={onStart}
        />
      </LocalHostScope>
    </>
  );
}

// Where the pull would refuse at step 2 (host/ipc/modules/sync.ts
// runPullWorktree): this device already has the branch, checked out
// in a worktree or merely existing. Read under LocalHostScope. Both
// lists are the ordinary cached ones, so the row and the footer
// asking the same question cost one read between them.
function useLocalCollision(
  localProject: Project,
  branch: string,
): { held: boolean; holder: Worktree | undefined } {
  const { data: branches } = useBranches(localProject.id);
  const { data: worktrees } = useWorktrees(localProject.id);
  const held = branches?.local.includes(branch) ?? false;
  const holder = held
    ? worktrees?.find((entry) => entry.branch === branch)
    : undefined;
  return { held, holder };
}

function DestinationRow({
  worktree,
  localProject,
  thisDeviceLabel,
}: {
  worktree: Worktree;
  localProject: Project;
  thisDeviceLabel: string;
}) {
  const { held, holder } = useLocalCollision(localProject, worktree.branch);
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

function ReviewFooter({
  worktree,
  localProject,
  sourceDeviceLabel,
  onCancel,
  onStart,
}: {
  worktree: Worktree;
  localProject: Project;
  sourceDeviceLabel: string;
  onCancel: () => void;
  onStart: () => void;
}) {
  const { held, holder } = useLocalCollision(localProject, worktree.branch);
  return (
    <TransplantFooter
      note={
        held
          ? pullBranchCollision(worktree.branch, holder?.path)
          : `Nothing on ${sourceDeviceLabel} is deleted until you say so at the last step.`
      }
    >
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" onClick={onStart} disabled={held}>
        Start transplant
        <ArrowRight />
      </Button>
    </TransplantFooter>
  );
}

function SourceCard({
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

// What a transfer leaves on the source: its ignored files. The capture
// has `git add -A` semantics (cli/cmd_dirty.go), so an .env or a build
// folder never crosses, and a teardown at the last step removes it
// with the source. Said here, where the user still decides, because
// nothing in the pull can refuse over it: near every real worktree
// carries ignored content. Under the source scope by the caller.
function StaysBehind({
  worktree,
  project,
  localProject,
  sourceDeviceLabel,
}: {
  worktree: Worktree;
  project: Project;
  localProject: Project;
  sourceDeviceLabel: string;
}) {
  const {
    data: ignored,
    isPending,
    isError,
  } = useWorktreeIgnoredPaths(project.id, worktree.id);
  return (
    <section className="space-y-2">
      <SectionHeading>
        Stays behind
        <span className="ml-1.5 font-normal tracking-normal normal-case">
          (ignored files never travel)
        </span>
      </SectionHeading>
      {isPending ? (
        <CardSkeleton />
      ) : isError ? (
        <p className={CARD_NOTE}>
          The ignored files there could not be listed. Anything gitignored stays
          on {sourceDeviceLabel}.
        </p>
      ) : ignored.total === 0 ? (
        <p className="text-xs text-muted-foreground">No ignored files there.</p>
      ) : (
        <>
          <CardList total={ignored.total}>
            {ignored.paths.slice(0, MAX_ROWS).map((path) => (
              <li key={path} className="min-w-0 truncate" title={path}>
                {path}
              </li>
            ))}
          </CardList>
          <p className="text-xs text-muted-foreground">
            Carry-over below recreates what {localProject.name} is configured
            for. A teardown at the last step removes the rest with the source.
          </p>
        </>
      )}
    </section>
  );
}

// The local project's carry-over: manual entries plus the repo's
// .worktreeinclude matches, merged by the same rule the Configure page
// uses. Under LocalHostScope by the caller. The include status is read
// unconditionally (like Configure does) so the two requests run side
// by side instead of the second waiting on the config.
function CarryOverList({
  localProject,
  thisDeviceLabel,
}: {
  localProject: Project;
  thisDeviceLabel: string;
}) {
  const { data: config, isPending } = useShigomoriConfig(localProject.id);
  const { data: include } = useWorktreeIncludeStatus(localProject.id);
  const manual = config?.carryOver ?? [];
  const included = worktreeIncludeExtras(
    manual,
    config?.useWorktreeInclude !== false,
    include,
  );
  const rows = [
    ...manual.map((e) => ({ path: e.path, tag: e.mode })),
    ...included.map((path) => ({ path, tag: "include" })),
  ];
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

// Where the worktree lands: the local layout's base folder, with the
// name left open -- the create picks a fresh pool name on arrival, so
// a full path here would be a guess.
function DestinationFolder({
  localProject,
  thisDeviceLabel,
}: {
  localProject: Project;
  thisDeviceLabel: string;
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
  return (
    <section className="space-y-2">
      <SectionHeading>Folder on {thisDeviceLabel}</SectionHeading>
      <div className="rounded-lg border border-border bg-card px-3 py-2.5 font-mono text-xs">
        {base === null ? (
          <Skeleton className="h-3.5 w-2/3" />
        ) : (
          <p className="truncate" title={base}>
            {base}/<span className="text-muted-foreground">‹new name›</span>
          </p>
        )}
      </div>
    </section>
  );
}
