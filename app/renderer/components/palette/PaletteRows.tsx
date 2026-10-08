import { Fragment, type ReactNode } from "react";
import { Loader2, Plus } from "lucide-react";
import { BranchLabel } from "@/components/ui/branch-label";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { useAllowAgentWorking } from "@/hooks/config/useSidebarMarks";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { DeviceBadge, MirrorBadge } from "@/components/sidebar/DeviceBadge";
import { ownerOf } from "@/components/sidebar/buildSidebarRows";
import { PullRequestPill } from "@/components/sidebar/PullRequestPill";
import { StatusIndicator } from "@/components/sidebar/StatusIndicator";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { matchPositions } from "@/lib/fuzzyMatch";
import { formatRelativeTime } from "@/lib/relativeTime";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { worktreeTitle } from "@/lib/worktreeTitle";
import {
  isAgentWorking,
  worktreeLastActivityAt,
  type Project,
} from "@shared/schemas";
import type {
  PaletteEntry,
  PalettePage,
  PaletteProject,
} from "./buildPaletteEntries";
import { SimpleTooltip } from "@/components/ui/tooltip";

// Everything the list can hold: the worktrees, the projects and pages a
// query names, and, for a query, the worktree it could make.
export type PaletteRow =
  | { kind: "worktree"; key: string; entry: PaletteEntry }
  | { kind: "project"; key: string; item: PaletteProject }
  | { kind: "page"; key: string; page: PalettePage }
  | {
      kind: "create";
      key: string;
      branch: string;
      // Where it can go, the one ↩ picks first.
      targets: [Project, ...Project[]];
    };

export function PaletteRowView({
  row,
  query,
  now,
  creating,
}: {
  row: PaletteRow;
  query: string;
  now: number;
  creating: boolean;
}) {
  switch (row.kind) {
    case "worktree":
      return <WorktreeRow entry={row.entry} query={query} now={now} />;
    case "project":
      return <ProjectRow item={row.item} query={query} />;
    case "page":
      return <PageRow page={row.page} query={query} />;
    case "create":
      return <CreateRow row={row} creating={creating} />;
  }
}

// The sidebar's reading of a worktree: project and folder under the
// branch with its last activity, its one most pressing status (the
// sidebar's rows have the room for both), and the device badge a peer's
// row wears (or the mirror badge a local pair wears). The letters the
// query matched are marked.
function WorktreeRow({
  entry,
  query,
  now,
}: {
  entry: PaletteEntry;
  query: string;
  now: number;
}) {
  const { worktree, project, device, mirror, pr } = entry;
  const allowAgentWorking = useAllowAgentWorking();
  const activeAt = worktreeLastActivityAt(worktree);
  // The sidebar's line: what the work is called, the branch without.
  const title = worktreeTitle(worktree, pr);
  const status = worktree.mergedIntoPrimary
    ? "merged"
    : isAgentWorking(worktree, allowAgentWorking)
      ? "agent working"
      : worktree.shelved
        ? "shelved"
        : undefined;
  return (
    <RowLayout
      dim={device !== undefined && !device.reachable}
      icon={
        <ProjectIcon
          projectId={worktree.projectId}
          name={project.name}
          deviceId={device?.deviceId}
        />
      }
      title={
        title !== null ? (
          <Highlight text={title} query={query} />
        ) : (
          <span className="font-mono">
            {worktree.detached ? (
              <BranchLabel branch={worktree.branch} detached />
            ) : (
              <Highlight text={worktree.branch} query={query} />
            )}
          </span>
        )
      }
      detail={
        <>
          <Highlight text={project.name} query={query} /> ·{" "}
          {title !== null && !worktree.detached && (
            <>
              <span className="font-mono">
                <Highlight text={worktree.branch} query={query} />
              </span>{" "}
              ·{" "}
            </>
          )}
          <Highlight text={worktree.name} query={query} />
          {activeAt > 0 && ` · ${formatRelativeTime(activeAt, now)}`}
          {status && ` · ${status}`}
        </>
      }
    >
      <PullRequestPill pr={pr} />
      <StatusIndicator worktree={worktree} />
      <WorktreeKindIcon worktree={worktree} />
      {device && <DeviceBadge badge={device} />}
      {mirror && <MirrorBadge mirror={mirror} />}
    </RowLayout>
  );
}

// A project under its owner, the sidebar's header for it, so a query
// naming the owner shows why the project is in the list.
function ProjectRow({ item, query }: { item: PaletteProject; query: string }) {
  const { project, device, worktreeCount, deviceCount } = item;
  const owner = ownerOf(project);
  return (
    <RowLayout
      dim={device !== undefined && !device.reachable}
      icon={
        <ProjectIcon
          projectId={project.id}
          name={project.name}
          deviceId={device?.deviceId}
        />
      }
      title={<Highlight text={project.name} query={query} />}
      detail={
        <>
          {owner && (
            <>
              <Highlight text={owner.name} query={query} /> ·{" "}
            </>
          )}
          {worktreeCount > 0
            ? pluralize(worktreeCount, "worktree")
            : "No worktrees"}
          {deviceCount > 1 && ` on ${deviceCount} devices`}
        </>
      }
    >
      {device && <DeviceBadge badge={device} />}
    </RowLayout>
  );
}

function PageRow({ page, query }: { page: PalettePage; query: string }) {
  const Icon = page.icon;
  return (
    <RowLayout
      icon={
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      }
      title={<Highlight text={page.label} query={query} />}
      detail={page.parent}
    />
  );
}

function CreateRow({
  row,
  creating,
}: {
  row: Extract<PaletteRow, { kind: "create" }>;
  creating: boolean;
}) {
  const [target] = row.targets;
  // What quickCreate forks from.
  const { data: base } = useDefaultBranch(target.id);
  const Icon = creating ? Loader2 : Plus;
  return (
    <RowLayout
      icon={
        <span className="inline-flex size-4 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <Icon
            aria-hidden
            className={cn("size-3", creating && "animate-spin")}
          />
        </span>
      }
      title={
        <>
          {creating ? "Creating " : "New worktree "}
          <span className="font-mono">{row.branch}</span>
        </>
      }
      detail={`in ${target.name}${base ? `, from ${base}` : ""}`}
    />
  );
}

function RowLayout({
  icon,
  title,
  detail,
  dim,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  dim?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2",
        dim && "opacity-60",
      )}
    >
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <SimpleTooltip whenTruncated lazy tip={title}>
          <span className="truncate text-xs">{title}</span>
        </SimpleTooltip>
        {detail && (
          <SimpleTooltip whenTruncated lazy tip={detail}>
            <span className="truncate text-3xs text-muted-foreground">
              {detail}
            </span>
          </SimpleTooltip>
        )}
      </div>
      {children}
    </div>
  );
}

// `text` with the letters the query matched drawn heavier and
// underlined, so a row shows why it is in the list.
function Highlight({ text, query }: { text: string; query: string }) {
  const positions = matchPositions(query, text);
  if (!positions) return text;
  const marked = new Set(positions);
  const runs: { start: number; text: string; marked: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs.at(-1);
    if (last && last.marked === marked.has(i)) last.text += text[i];
    else runs.push({ start: i, text: text[i] ?? "", marked: marked.has(i) });
  }
  return runs.map((run) =>
    run.marked ? (
      <mark
        key={run.start}
        className="bg-transparent font-semibold text-current underline decoration-primary/70 decoration-2 underline-offset-2"
      >
        {run.text}
      </mark>
    ) : (
      <Fragment key={run.start}>{run.text}</Fragment>
    ),
  );
}
