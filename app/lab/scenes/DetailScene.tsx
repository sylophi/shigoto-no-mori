// The worktree page, the main pane right of the sidebar, for a fixture
// worktree on Studio Mac (this machine): happy-hummingbird with its
// open PR ready to merge, brave-badger with its merged PR at the bottom
// of a stack, and the main checkout's Launch section on its own.
// WorktreeDetailPane is the page alone, for a lead composing a whole
// window. The scenes wrap it in the window's main pane.
import type { ReactNode } from "react";
import { FooterLeadingVerbView } from "@/components/worktreeDetail/FooterLeadingVerbView";
import { LaunchSectionView } from "@/components/worktreeDetail/LaunchSectionView";
import { LauncherRowView } from "@/components/worktreeDetail/LauncherRowView";
import { NotesSectionView } from "@/components/worktreeDetail/NotesSectionView";
import { ScriptLaunchRowView } from "@/components/worktreeDetail/ScriptLaunchRowView";
import { WorktreeDetailFooterView } from "@/components/worktreeDetail/WorktreeDetailFooterView";
import { WorktreeDetailView } from "@/components/worktreeDetail/WorktreeDetailView";
import { WorktreePrimarySyncPillView } from "@/components/worktreeDetail/WorktreePrimarySyncPillView";
import { WorktreeSyncPillView } from "@/components/worktreeDetail/WorktreeSyncPillView";
import { CommitsSectionView } from "@/components/worktreeDetail/commits/CommitsSectionView";
import { ClosedPullRequestBoxView } from "@/components/worktreeDetail/pullRequests/ClosedPullRequestBoxView";
import { MergeBoxView } from "@/components/worktreeDetail/pullRequests/MergeBoxView";
import { mergeBoxState } from "@/components/worktreeDetail/pullRequests/mergeBoxState";
import { PullRequestIdentityView } from "@/components/worktreeDetail/pullRequests/PullRequestIdentityView";
import {
  PullRequestBodyView,
  PullRequestSectionView,
} from "@/components/worktreeDetail/pullRequests/PullRequestSectionView";
import { StackList } from "@/components/worktreeDetail/pullRequests/StackList";
import { PackageScriptsView } from "@/components/worktreeDetail/scripts/PackageScriptsView";
import { ScriptsSectionView } from "@/components/worktreeDetail/scripts/ScriptsSectionView";
import {
  deriveRemoteSyncState,
  hasWorktreeData,
  type Project,
  type Worktree,
} from "@shared/schemas";
import {
  labLauncherEntries,
  labPackageScriptSort,
  labShigomoriConfig,
} from "../fixtures";
import { LAB_REPO_MERGE_CONFIG } from "../pullRequestFixtures";
import {
  NOW,
  footerVerbsOf,
  homeOf,
  lifecycleOf,
  packageScriptsOf,
  pullRequestDetailOf,
  stackCleanupCountOf,
  worktreeById,
} from "./world";

export interface WorktreeDetailPaneProps {
  // The fixture worktree (lab/fixtures.ts), by id.
  worktreeId: string;
  // The whole stack landed, as ?stack=merged poses it.
  mergedStack?: boolean;
  // The time ages count back from.
  now?: number;
}

// The worktree page for a fixture worktree, filling its parent's height.
export function WorktreeDetailPane({
  worktreeId,
  mergedStack = false,
  now = NOW,
}: WorktreeDetailPaneProps) {
  const { worktree, project, deviceId } = worktreeById(worktreeId);
  return (
    <WorktreeDetailView
      worktree={worktree}
      projectName={project.name}
      home={homeOf(deviceId)}
      resident={null}
      launch={<LaunchScene />}
      pullRequest={
        <PullRequestScene
          worktree={worktree}
          project={project}
          mergedStack={mergedStack}
          now={now}
        />
      }
      commits={<CommitsScene worktree={worktree} now={now} />}
      scripts={
        <ScriptsSectionView
          packageScripts={
            <PackageScriptsView
              sortMode={labPackageScriptSort}
              scripts={packageScriptsOf()}
            />
          }
          lifecycle={lifecycleOf(worktree)}
          offerConfigure
        />
      }
      notes={hasWorktreeData(worktree) && <NotesSectionView notes="" />}
      footer={
        <WorktreeDetailFooterView
          worktree={worktree}
          state={{
            kind: "normal",
            confirmDelete: false,
            busy: false,
            deleteBlockedReason: undefined,
          }}
          leading={footerVerbsOf(worktree, project).map((verb) => (
            <FooterLeadingVerbView key={verb.kind} verb={verb} />
          ))}
        />
      }
    />
  );
}

// The Launch section, the same on every worktree of the project: the
// tools, then the scripts on one line.
function LaunchScene() {
  return (
    <LaunchSectionView
      launchers={<LauncherRowView entries={labLauncherEntries} />}
      scripts={<ScriptLaunchRowView scripts={packageScriptsOf()} />}
    />
  );
}

function PullRequestScene({
  worktree,
  project,
  mergedStack,
  now,
}: {
  worktree: Worktree;
  project: Project;
  mergedStack: boolean;
  now: number;
}) {
  if (worktree.detached) return null;
  const { pr, stack } = pullRequestDetailOf(
    project,
    worktree.branch,
    mergedStack,
  );
  if (!pr) return null;
  const isOpen = pr.state === "OPEN";
  return (
    <PullRequestSectionView>
      <PullRequestBodyView>
        <PullRequestIdentityView pr={pr} now={now} />
        {stack && <StackList worktree={worktree} stack={stack} />}
        {isOpen && (
          <MergeBoxView
            pr={pr}
            state={mergeBoxState({
              pr,
              repoConfig: LAB_REPO_MERGE_CONFIG,
              lastMergeMethod: labShigomoriConfig.lastMergeMethod,
              stack,
            })}
          />
        )}
        {!isOpen && !worktree.isPrimary && (
          <ClosedPullRequestBoxView
            stackCount={stackCleanupCountOf(project, stack)}
          />
        )}
      </PullRequestBodyView>
    </PullRequestSectionView>
  );
}

function CommitsScene({ worktree, now }: { worktree: Worktree; now: number }) {
  const showPrimarySync =
    !worktree.isPrimary &&
    !worktree.detached &&
    worktree.changedCount === 0 &&
    worktree.behindPrimary > 0;
  return (
    <CommitsSectionView
      changedCount={worktree.changedCount}
      syncPill={
        <WorktreeSyncPillView
          state={deriveRemoteSyncState(worktree)}
          autoPull={worktree.autoPull}
        />
      }
      commits={worktree.recentCommits.slice(0, 3)}
      now={now}
      primarySync={
        showPrimarySync && (
          <WorktreePrimarySyncPillView
            behindPrimary={worktree.behindPrimary}
            primaryRef={worktree.primaryRef}
          />
        )
      }
      showAll={worktree.recentCommits.length > 3}
    />
  );
}

// The window's main pane, which the page sits in: its background and
// its doubutsu wallpaper.
function MainPane({
  height,
  children,
}: {
  height: number;
  children: ReactNode;
}) {
  return (
    <main
      data-doubutsu-zone="main"
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background"
      style={{ height }}
    >
      {children}
    </main>
  );
}

// happy-hummingbird: PR #148 open, two checks passed, ready to merge,
// with three files changed and two commits on the branch.
export function DetailHummingbirdScene({
  height = 900,
  now,
}: {
  height?: number;
  now?: number;
}) {
  return (
    <MainPane height={height}>
      <WorktreeDetailPane worktreeId="5a0000000002" now={now} />
    </MainPane>
  );
}

// brave-badger: PR #150 merged, the bottom of a stack of three that
// lands on main, its worktree ready to delete and two commits to push.
export function DetailBadgerScene({
  height = 900,
  now,
  mergedStack = false,
}: {
  height?: number;
  now?: number;
  mergedStack?: boolean;
}) {
  return (
    <MainPane height={height}>
      <WorktreeDetailPane
        worktreeId="5a0000000003"
        now={now}
        mergedStack={mergedStack}
      />
    </MainPane>
  );
}

// The main checkout's Launch section on its own (the section is the
// same on every worktree of the project): the tools and the
// package.json scripts.
export function LaunchRowScene() {
  return (
    <div data-slot="launch-row" className="p-6">
      <LaunchScene />
    </div>
  );
}
