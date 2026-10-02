import { Fragment, type ReactNode } from "react";
import { Loader2, Plus } from "lucide-react";
import { BranchLabel } from "@/components/ui/branch-label";
import { ProjectIcon } from "@/components/shared/ProjectIcon";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { DeviceBadge, MirrorBadge } from "@/components/sidebar/DeviceBadge";
import { PullRequestPill } from "@/components/sidebar/PullRequestPill";
import { StatusIndicator } from "@/components/sidebar/StatusIndicator";
import { useDefaultBranch } from "@/hooks/git/useDefaultBranch";
import { matchPositions } from "@/lib/fuzzyMatch";
import { formatRelativeTime } from "@/lib/relativeTime";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { worktreeLastActivityAt, type Project } from "@shared/schemas";
import type { PaletteEntry, PaletteProject } from "./buildPaletteEntries";

// Everything the list can hold: the worktrees, the projects a query
// names, and, for a query, the worktree it could make.
export type PaletteRow =
  | { kind: "worktree"; key: string; entry: PaletteEntry }
  | { kind: "project"; key: string; item: PaletteProject }
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
  const activeAt = worktreeLastActivityAt(worktree);
  const status = worktree.mergedIntoPrimary
    ? "merged"
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
        <span className="font-mono">
          {worktree.detached ? (
            <BranchLabel branch={worktree.branch} detached />
          ) : (
            <Highlight text={worktree.branch} query={query} />
          )}
        </span>
      }
      detail={
        <>
          <Highlight text={project.name} query={query} /> ·{" "}
          <Highlight text={worktree.name} query={query} />
          {activeAt > 0 && ` · ${formatRelativeTime(activeAt, now)}`}
          {status && ` · ${status}`}
        </>
      }
    >
      <PullRequestPill pr={pr} />
      <StatusIndicator worktree={worktree} />
      <WorktreeKindIcon worktree={worktree} showTooltip={false} />
      {device && <DeviceBadge badge={device} />}
      {mirror && <MirrorBadge mirror={mirror} />}
    </RowLayout>
  );
}

function ProjectRow({ item, query }: { item: PaletteProject; query: string }) {
  const { project, device, worktreeCount, deviceCount } = item;
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
  detail: ReactNode;
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
        <span className="truncate text-xs">{title}</span>
        <span className="truncate text-3xs text-muted-foreground">
          {detail}
        </span>
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
