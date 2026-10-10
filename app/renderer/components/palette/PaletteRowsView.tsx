import { Fragment, type ReactNode } from "react";
import { Loader2, Plus } from "lucide-react";
import { BranchLabel } from "@/components/ui/branch-label";
import {
  DeviceBadgeView,
  MirrorBadgeView,
} from "@/components/sidebar/DeviceBadgeView";
import { ownerOf } from "@/components/sidebar/buildSidebarRows";
import { PullRequestPillView } from "@/components/sidebar/PullRequestPillView";
import { StatusIndicatorView } from "@/components/sidebar/StatusIndicatorView";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { matchPositions } from "@/lib/fuzzyMatch";
import { formatRelativeTime } from "@/lib/relativeTime";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { worktreeTitle } from "@/lib/worktreeTitle";
import { worktreeLastActivityAt } from "@shigomori/contracts/schemas";
import type {
  PaletteEntry,
  PalettePage,
  PaletteProject,
} from "./buildPaletteEntries";

// The palette's rows, each kind drawn (PaletteRows.tsx binds them).

// The sidebar's reading of a worktree: project and folder under the
// branch with its last activity, its one most pressing status (the
// sidebar's rows have the room for both), and the device badge a peer's
// row wears (or the mirror badge a local pair wears). The letters the
// query matched are marked.
export function WorktreeRowView({
  entry,
  query,
  now,
  status,
  showBadge,
  icon,
  kindIcon,
}: {
  entry: PaletteEntry;
  query: string;
  now: number;
  // The one most pressing status, in words.
  status: string | undefined;
  showBadge: boolean;
  // The project's icon (ProjectIcon).
  icon: ReactNode;
  // The worktree's kind (WorktreeKindIcon).
  kindIcon: ReactNode;
}) {
  const { worktree, project, device, mirror, pr } = entry;

  const activeAt = worktreeLastActivityAt(worktree);
  // The sidebar's line: what the work is called, the branch without.
  const title = worktreeTitle(worktree, pr);

  return (
    <PaletteRowLayoutView
      dim={device !== undefined && !device.reachable}
      icon={icon}
      title={
        title !== null ? (
          <HighlightView text={title} query={query} />
        ) : (
          <span className="font-mono">
            {worktree.detached ? (
              <BranchLabel branch={worktree.branch} detached />
            ) : (
              <HighlightView text={worktree.branch} query={query} />
            )}
          </span>
        )
      }
      detail={
        <>
          <HighlightView text={project.name} query={query} /> ·{" "}
          {title !== null && !worktree.detached && (
            <>
              <span className="font-mono">
                <HighlightView text={worktree.branch} query={query} />
              </span>{" "}
              ·{" "}
            </>
          )}
          <HighlightView text={worktree.name} query={query} />
          {activeAt > 0 && ` · ${formatRelativeTime(activeAt, now)}`}
          {status && ` · ${status}`}
        </>
      }
    >
      <PullRequestPillView pr={pr} />
      <StatusIndicatorView worktree={worktree} />
      {kindIcon}
      {device && <DeviceBadgeView badge={device} />}
      {mirror && <MirrorBadgeView mirror={mirror} showBadge={showBadge} />}
    </PaletteRowLayoutView>
  );
}

// A project under its owner, the sidebar's header for it, so a query
// naming the owner shows why the project is in the list.
export function ProjectRowView({
  item,
  query,
  icon,
}: {
  item: PaletteProject;
  query: string;
  // The project's icon (ProjectIcon).
  icon: ReactNode;
}) {
  const { project, device, worktreeCount, deviceCount } = item;
  const owner = ownerOf(project);
  return (
    <PaletteRowLayoutView
      dim={device !== undefined && !device.reachable}
      icon={icon}
      title={<HighlightView text={project.name} query={query} />}
      detail={
        <>
          {owner && (
            <>
              <HighlightView text={owner.name} query={query} /> ·{" "}
            </>
          )}
          {worktreeCount > 0
            ? pluralize(worktreeCount, "worktree")
            : "No worktrees"}
          {deviceCount > 1 && ` on ${deviceCount} devices`}
        </>
      }
    >
      {device && <DeviceBadgeView badge={device} />}
    </PaletteRowLayoutView>
  );
}

export function PageRowView({
  page,
  query,
}: {
  page: PalettePage;
  query: string;
}) {
  const Icon = page.icon;
  return (
    <PaletteRowLayoutView
      icon={
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      }
      title={<HighlightView text={page.label} query={query} />}
      detail={page.parent}
    />
  );
}

// The worktree a query could make: its branch, the project it goes in,
// and what it forks from.
export function CreateRowView({
  branch,
  projectName,
  base,
  creating,
}: {
  branch: string;
  projectName: string;
  // The project's default branch, once read.
  base: string | undefined;
  creating: boolean;
}) {
  const Icon = creating ? Loader2 : Plus;
  return (
    <PaletteRowLayoutView
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
          <span className="font-mono">{branch}</span>
        </>
      }
      detail={`in ${projectName}${base ? `, from ${base}` : ""}`}
    />
  );
}

export function PaletteRowLayoutView({
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
export function HighlightView({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
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
