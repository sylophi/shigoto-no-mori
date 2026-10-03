// The worktree page as drawn: the header (project, path, kind, device,
// resident, branch title, mirror line), a lifecycle banner, the
// sections, and the footer. WorktreeDetailInner feeds it, passing its
// live parts (the renaming title, the activity line, the sections) as
// nodes. A scene passes the sections' views instead
// (LaunchSectionView, PullRequestSectionView, CommitsSectionView,
// ScriptsSectionView, NotesSectionView, WorktreeDetailFooterView).
import type { ReactNode } from "react";
import { PAGE_BODY, PAGE_HEADER_PADDING } from "@/components/shared/pageInsets";
import { WorktreeKindIcon } from "@/components/shared/WorktreeKindIcon";
import { PathSpan } from "@/components/ui/path-span";
import { SectionHeading } from "@/components/ui/section-heading";
import {
  BirthdayParty,
  PARTY_HOST,
} from "@/components/villagers/BirthdayParty";
import { ResidentFace } from "@/components/villagers/ResidentFace";
import type { Resident } from "@/hooks/villagers/useResident";
import { cn } from "@/lib/utils";
import type { Worktree } from "@shared/schemas";
import { BranchTitleView } from "./branch/BranchTitleView";
import { LifecycleBanner } from "./LifecycleBanner";

export interface WorktreeDetailViewProps {
  worktree: Worktree;
  projectName: string;
  // The home folder the path is shortened against (~/...).
  home: string | null;
  onOpenProject?: () => void;
  // The device chip (DeviceChipView) on a peer's page.
  deviceChip?: ReactNode;
  resident: Resident | null;
  // The resident's birthday, thrown in the header.
  party?: boolean;
  // The branch title, BranchTitleView over the worktree's branch when
  // not given.
  title?: ReactNode;
  // Beside the title: WorktreeActivityIndicator.
  activity?: ReactNode;
  // Under the title: MirrorPill.
  mirror?: ReactNode;
  // A create or removal under way, which may lock the page.
  banner?: string | null;
  locked?: boolean;
  launch: ReactNode;
  pullRequest: ReactNode;
  commits: ReactNode;
  // The Scripts section's body (ScriptsSectionView), under its heading.
  scripts: ReactNode;
  notes: ReactNode;
  footer: ReactNode;
}

export function WorktreeDetailView({
  worktree,
  projectName,
  home,
  onOpenProject,
  deviceChip,
  resident,
  party = false,
  title,
  activity,
  mirror,
  banner = null,
  locked = false,
  launch,
  pullRequest,
  commits,
  scripts,
  notes,
  footer,
}: WorktreeDetailViewProps) {
  const host = party && resident !== null ? resident : null;
  return (
    <div className="flex h-full flex-col">
      <header
        className={cn(
          "flex flex-col gap-2 border-b border-border",
          PAGE_HEADER_PADDING,
          "pb-5 phone:pb-4",
          host && PARTY_HOST,
        )}
      >
        {host && <BirthdayParty villager={host} />}
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={onOpenProject}
            className="-mx-1 shrink-0 rounded px-1 transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-muted/50"
            title={`Configure ${projectName}`}
          >
            {projectName}
          </button>
          {/* A phone has no room for the path (it shortens to noise
              at that width), so the breadcrumb stops at the project
              and the trailing marks push themselves to the edge. */}
          <span aria-hidden className="text-muted-foreground/40 phone:hidden">
            /
          </span>
          <PathSpan
            path={worktree.path}
            home={home}
            className="min-w-0 flex-1 font-mono phone:hidden"
            copyable
          />
          {/* Held at the text line's height: the device chip overhangs
              it, so a peer's header is as tall as a local one. */}
          <span className="flex h-4 shrink-0 items-center gap-1.5 phone:ml-auto">
            <WorktreeKindIcon worktree={worktree} />
            {deviceChip}
          </span>
        </div>
        <div className="flex min-w-0 items-start gap-3">
          <ResidentFace resident={resident} party={host !== null} />
          <div className="min-w-0 flex-1">
            {title ?? (
              <BranchTitleView
                branch={worktree.branch}
                detached={worktree.detached}
              />
            )}
          </div>
          {activity}
        </div>
        {mirror}
      </header>

      {banner && <LifecycleBanner label={banner} />}

      <div
        className={cn(
          PAGE_BODY,
          "phone:py-5",
          locked && "pointer-events-none opacity-50",
        )}
        aria-disabled={locked}
      >
        <div className="flex flex-col gap-10 phone:gap-8">
          {launch}

          {pullRequest}

          {commits}

          <section className="space-y-3">
            <SectionHeading>Scripts</SectionHeading>
            {scripts}
          </section>

          {notes}
        </div>
      </div>

      {footer}
    </div>
  );
}
