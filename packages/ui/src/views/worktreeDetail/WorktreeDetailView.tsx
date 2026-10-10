// The worktree page (WorktreeDetailInner binds it): a header naming the
// work and where it lives, the sections, and the footer's verbs.
import type { ReactNode } from "react";
import {
  PAGE_HEADER_PADDING,
  PAGE_HEADER_TABS_PADDING,
  PAGE_HEADER_TABS_ROW,
} from "../shared/PageHeaderView.tsx";
import { PAGE_BODY } from "../shared/PageShellView.tsx";
import { Button } from "../../primitives/button.tsx";
import { CenteredMessage } from "../../primitives/centered-message.tsx";
import { SectionHeading } from "../../primitives/section-heading.tsx";
import { SimpleTooltip } from "../../primitives/tooltip.tsx";
import { PARTY_HOST } from "../villagers/BirthdayPartyView.tsx";
import { cn } from "../../lib/utils.ts";
import { LifecycleBannerView } from "./LifecycleBannerView.tsx";

export function WorktreeDetailView({
  party,
  copyTabs,
  projectName,
  onConfigure,
  location,
  marks,
  face,
  header,
  mirrorPill,
  banner,
  locked,
  description,
  prLead,
  launch,
  prSection,
  git,
  ports,
  scripts,
  footer,
  drawer,
}: {
  // The resident's birthday party (BirthdayPartyView), thrown in the header.
  party?: ReactNode;
  // The mirror's copies as tabs (MirrorCopyTabs), leading the header.
  copyTabs?: ReactNode;
  projectName: string;
  // The breadcrumb's project, linked to its Configure page.
  onConfigure: () => void;
  // Where the worktree lives (WorktreeLocation).
  location: ReactNode;
  // The marks at the breadcrumb's end: the page's refresh, the kind
  // icon, and the device chip.
  marks: ReactNode;
  // The resident's face (ResidentFaceView) beside the title (WorktreeHeader).
  face: ReactNode;
  header: ReactNode;
  mirrorPill: ReactNode;
  // A create or a removal under way.
  banner: string | null;
  // The page is locked while files move in or the worktree goes.
  locked: boolean;
  // The sections, in the page's order.
  description?: ReactNode;
  prLead?: ReactNode;
  launch: ReactNode;
  prSection?: ReactNode;
  git: ReactNode;
  ports: ReactNode;
  scripts: ReactNode;
  footer: ReactNode;
  // The terminal drawer, under the footer while it is open.
  drawer?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col">
      <header
        className={cn(
          "flex flex-col gap-2 border-b border-border",
          PAGE_HEADER_PADDING,
          "pb-5 phone:pb-4",
          copyTabs && PAGE_HEADER_TABS_PADDING,
          party && PARTY_HOST,
        )}
      >
        {party}
        {copyTabs && (
          <div className={cn("mb-1", PAGE_HEADER_TABS_ROW)}>{copyTabs}</div>
        )}
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <SimpleTooltip tip={`Configure ${projectName}`}>
            <button
              type="button"
              onClick={onConfigure}
              className="-mx-1 shrink-0 rounded px-1 transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-muted/50"
            >
              {projectName}
            </button>
          </SimpleTooltip>
          {/* A phone has no room for the path (it shortens to noise
              at that width), so the breadcrumb stops at the project
              and the trailing marks push themselves to the edge. */}
          <span aria-hidden className="text-muted-foreground/40 phone:hidden">
            /
          </span>
          {location}
          {/* Held at the text line's height: the device chip overhangs
              it, so a peer's header is as tall as a local one. */}
          <span className="flex h-4 shrink-0 items-center gap-1.5 phone:ml-auto">
            {marks}
          </span>
        </div>
        {/* The face centered on the lines beside it. */}
        <div className="flex min-w-0 items-center gap-3">
          {face}
          <div className="min-w-0 flex-1">{header}</div>
        </div>
        {mirrorPill}
      </header>

      {banner && <LifecycleBannerView label={banner} />}

      <div
        className={cn(
          PAGE_BODY,
          "phone:py-5",
          locked && "pointer-events-none opacity-50",
        )}
        aria-disabled={locked}
      >
        <div className="flex flex-col gap-10 phone:gap-8">
          {/* What the work is leads the page, and under a PR's header
              what to do about the PR. Hidden while neither has come,
              so it takes no gap. */}
          <div className="space-y-5 empty:hidden">
            {description}
            {prLead}
          </div>

          {launch}
          {prSection}
          {git}
          {ports}
          <section className="space-y-3">
            <SectionHeading>Scripts</SectionHeading>
            {scripts}
          </section>
        </div>
      </div>

      {footer}
      {drawer}
    </div>
  );
}

// The page with no worktree to show: its listing failed, with a retry,
// since the worktrees query is silent on error (the sidebar owns that
// message), or the worktree isn't in it.
export function WorktreeUnavailableView({
  onRetry,
}: {
  // Set when the listing failed.
  onRetry?: () => void;
}) {
  if (onRetry === undefined) {
    return <CenteredMessage>Worktree not found.</CenteredMessage>;
  }
  return (
    <CenteredMessage className="flex-col gap-3">
      Couldn't load worktrees.
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </CenteredMessage>
  );
}
