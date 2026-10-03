// The worktree page, the main pane right of the sidebar, for a fixture
// worktree on Studio Mac (this machine), nothing running in it. The
// live page (WorktreeDetailInner) fills the same view with the sections
// that read the app, and this one with their views.
import { FooterLeadingVerbView } from "@/components/worktreeDetail/FooterLeadingVerbView";
import { LaunchSectionView } from "@/components/worktreeDetail/LaunchSectionView";
import { LauncherRowView } from "@/components/worktreeDetail/LauncherRowView";
import { NotesSectionView } from "@/components/worktreeDetail/NotesSectionView";
import { ScriptLaunchRowView } from "@/components/worktreeDetail/ScriptLaunchRowView";
import { WorktreeDetailFooterView } from "@/components/worktreeDetail/WorktreeDetailFooterView";
import { WorktreeDetailView } from "@/components/worktreeDetail/WorktreeDetailView";
import { WorktreePrimarySyncPillView } from "@/components/worktreeDetail/WorktreePrimarySyncPillView";
import { WorktreeSyncPillView } from "@/components/worktreeDetail/WorktreeSyncPillView";
import { CommitRowView } from "@/components/worktreeDetail/commits/CommitRowView";
import { CommitsSectionView } from "@/components/worktreeDetail/commits/CommitsSectionView";
import { commitsTeaser } from "@/components/worktreeDetail/commits/commitsTeaser";
import { ClosedPullRequestBoxView } from "@/components/worktreeDetail/pullRequests/ClosedPullRequestBoxView";
import { MergeBoxView } from "@/components/worktreeDetail/pullRequests/MergeBoxView";
import { mergeBoxState } from "@/components/worktreeDetail/pullRequests/mergeBoxState";
import { pullRequestFollowUp } from "@/components/worktreeDetail/pullRequests/pullRequestFollowUp";
import { PullRequestIdentityView } from "@/components/worktreeDetail/pullRequests/PullRequestIdentityView";
import { PullRequestSectionView } from "@/components/worktreeDetail/pullRequests/PullRequestSectionView";
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
import { NOW, homeOf, worktreeById } from "./world";
import {
  footerVerbsOf,
  lifecycleOf,
  packageScriptsOf,
  pullRequestDetailOf,
  stackCleanupCountOf,
} from "./world/worktreePage";

// The page for a fixture worktree (lab/fixtures.ts), by id, filling its
// parent's height.
export function WorktreeDetailPane({ worktreeId }: { worktreeId: string }) {
  const { worktree, project, deviceId } = worktreeById(worktreeId);
  return (
    <WorktreeDetailView
      worktree={worktree}
      projectName={project.name}
      home={homeOf(deviceId)}
      resident={null}
      launch={<LaunchSection />}
      pullRequest={<PullRequestSection worktree={worktree} project={project} />}
      commits={<CommitsSection worktree={worktree} />}
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
// tools, then the package.json scripts on one line.
export function LaunchSection() {
  return (
    <LaunchSectionView
      launchers={<LauncherRowView entries={labLauncherEntries} />}
      scripts={<ScriptLaunchRowView scripts={packageScriptsOf()} />}
    />
  );
}

function PullRequestSection({
  worktree,
  project,
}: {
  worktree: Worktree;
  project: Project;
}) {
  if (worktree.detached) return null;
  const { pr, stack } = pullRequestDetailOf(project, worktree.branch);
  if (!pr) return null;
  const followUp = pullRequestFollowUp(pr, worktree);
  return (
    <PullRequestSectionView>
      <PullRequestIdentityView pr={pr} now={NOW} />
      {stack && <StackList worktree={worktree} stack={stack} />}
      {followUp === "merge" && (
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
      {followUp === "cleanUp" && (
        <ClosedPullRequestBoxView
          stackCount={stackCleanupCountOf(project, stack)}
        />
      )}
      {/* "catchUpPrimary" has no view yet: no fixture's primary checkout
          holds a merged PR. */}
    </PullRequestSectionView>
  );
}

function CommitsSection({ worktree }: { worktree: Worktree }) {
  const { commits, showAll, showPrimarySync } = commitsTeaser(worktree);
  return (
    <CommitsSectionView
      changedCount={worktree.changedCount}
      syncPill={
        <WorktreeSyncPillView
          state={deriveRemoteSyncState(worktree)}
          autoPull={worktree.autoPull}
        />
      }
      commits={commits}
      renderCommit={(commit) => <CommitRowView commit={commit} now={NOW} />}
      primarySync={
        showPrimarySync && (
          <WorktreePrimarySyncPillView
            behindPrimary={worktree.behindPrimary}
            primaryRef={worktree.primaryRef}
          />
        )
      }
      showAll={showAll}
    />
  );
}
