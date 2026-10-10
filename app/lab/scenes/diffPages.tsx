// The diff pages over the fixtures: happy-hummingbird's uncommitted
// changes with the commit box under its list, one of its commits with
// its moves, and the pages' other pieces.
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { ReactNode } from "react";
import { ArrowUp } from "lucide-react";
import { BranchBarView } from "@/components/diff/BranchBarView";
import type { DiffChangesControls } from "@/components/diff/changesControls";
import { CommitComposerView } from "@/components/diff/CommitComposerView";
import {
  CommitDetailsView,
  CommitStepsView,
} from "@/components/diff/CommitDetailsView";
import { DiffFileIndexView } from "@/components/diff/DiffFileIndexView";
import {
  DiffFileRowView,
  DiffFilesSheetView,
  DiffHeaderView,
  DiffPageView,
  DiffPaneView,
} from "@/components/diff/DiffPageView";
import {
  BranchDiffSubtitleView,
  CommitBylineView,
  PullRequestDiffSubtitleView,
  PullRequestDiffTitleView,
  WorktreeDiffSubtitleView,
} from "@/components/diff/DiffTitlesView";
import { HunkBarView } from "@/components/diff/HunkBarView";
import { LastCommitStripView } from "@/components/diff/LastCommitStripView";
import {
  ChangesFooterView,
  CleanTreeMessageView,
} from "@/components/diff/WorktreeDiffView";
import { SidebarTakeoverView } from "@/components/sidebar/SidebarTakeoverView";
import { SyncActionButtonView } from "@/components/worktreeDetail/SyncActionButtonView";
import { peerReadOnlyNote } from "@/lib/commandAccessCopy";
import { changeEntries, fileKey, patchEntries } from "@/lib/patchFiles";
import { changeKey } from "@shigomori/contracts/schemas";
import { createFakeChanges } from "../fake-host/changesFixtures";
import { LOCAL_DEVICE_ID } from "../fake-host/fixtures";
import { FAKE_DIFF } from "../fake-host/pullRequestFixtures";
import { SceneWindowFrame } from "./frame";
import { SceneSidebar } from "./sidebar";
import { projectNamed, worktreeNamed } from "./world";

const noop = () => {};
const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");
const HUM = worktreeNamed(SM, "happy-hummingbird");
const CHANGES = createFakeChanges(() => ({ ...HUM }));
const FILES = CHANGES.status(HUM.id);
const PICKED = FILES[0];

const filesOf = (patch: string): FileDiffMetadata[] =>
  parsePatchFiles(patch).flatMap((p) => p.files);

const CONTROLS: DiffChangesControls = {
  files: FILES,
  loading: false,
  failed: false,
  busy: false,
  readOnly: false,
  selectedKey: PICKED ? changeKey(PICKED) : null,
  onSelect: noop,
  onSetStaged: noop,
  onDiscard: noop,
  onStash: noop,
  onResolve: noop,
};

const HUNKS = {
  states: PICKED
    ? CHANGES.hunks(HUM.id, PICKED.path)
    : { changes: [], editable: true },
  onSetStaged: noop,
  onDiscard: noop,
};

// A diff page in the window, its file list in the sidebar.
function diffPage({
  index,
  header,
  files,
  singleFile,
}: {
  index: ReactNode;
  header: ReactNode;
  files: FileDiffMetadata[];
  singleFile: boolean;
}) {
  return (
    <SceneWindowFrame
      sidebar={
        <SceneSidebar
          view="projects"
          open
          takeover={
            <SidebarTakeoverView back={{ label: HUM.name, onClick: noop }}>
              {index}
            </SidebarTakeoverView>
          }
        />
      }
      pathname="/projects"
    >
      <DiffPageView
        takeover={null}
        header={header}
        pane={
          <DiffPaneView state="files" message={null} virtualizer={null}>
            {files.map((fileDiff) => (
              <DiffFileRowView
                key={fileKey(fileDiff)}
                fileDiff={fileDiff}
                fileId={fileKey(fileDiff)}
                collapsed={false}
                diffStyle="unified"
                wrapLines={false}
                themeType="light"
                onToggle={singleFile ? undefined : noop}
                hunks={singleFile ? HUNKS : undefined}
                busy={false}
              />
            ))}
          </DiffPaneView>
        }
        sheet={null}
      />
    </SceneWindowFrame>
  );
}

function pageHeader(
  title: ReactNode,
  subtitle: ReactNode,
  extra?: {
    steps?: ReactNode;
    details?: ReactNode;
  },
) {
  return (
    <DiffHeaderView
      title={title}
      subtitle={subtitle}
      back={null}
      steps={extra?.steps}
      files={null}
      wrapLines={false}
      onToggleWrap={noop}
      diffStyle="unified"
      onDiffStyle={noop}
      details={extra?.details}
    />
  );
}

const branchBar = (
  <BranchBarView
    branch={HUM.branch}
    detached={false}
    rebasing={false}
    syncPill={
      <SyncActionButtonView
        tone="emerald"
        icon={ArrowUp}
        label="Push 2"
        pending={false}
        onClick={noop}
      />
    }
  />
);

// happy-hummingbird's uncommitted changes, its first file picked.
export function ChangesPageScene() {
  const last = HUM.recentCommits[0];
  return diffPage({
    singleFile: true,
    files: PICKED ? filesOf(CHANGES.fileDiff(HUM.id, [PICKED.path])) : [],
    index: (
      <DiffFileIndexView
        entries={changeEntries(FILES)}
        activeKey={CONTROLS.selectedKey}
        collapsedKeys={new Set()}
        onSelect={noop}
        allCollapsed={false}
        changes={CONTROLS}
        className="min-h-0 flex-1"
        footer={
          <ChangesFooterView
            branchBar={branchBar}
            lastCommit={
              last && (
                <LastCommitStripView
                  commit={last}
                  amending={false}
                  canUndo
                  busy={false}
                  onAmend={noop}
                  onUndo={noop}
                />
              )
            }
            composer={
              <CommitComposerView
                files={FILES}
                draft={{
                  summary: "Say what the commit button takes",
                  description: "",
                }}
                onDraftChange={noop}
                pending={false}
                error={null}
                amend={null}
                onCommit={noop}
              />
            }
            readOnlyNote={null}
          />
        }
      />
    ),
    header: pageHeader(
      "Uncommitted changes",
      <WorktreeDiffSubtitleView
        changedCount={FILES.length}
        worktreeName={HUM.name}
      />,
    ),
  });
}

// One of happy-hummingbird's commits, read as one scroll.
export function CommitPageScene() {
  const commit = HUM.recentCommits[0];
  const files = filesOf(FAKE_DIFF);
  return diffPage({
    singleFile: false,
    files,
    index: (
      <DiffFileIndexView
        entries={patchEntries(files)}
        activeKey={files[0] ? fileKey(files[0]) : null}
        collapsedKeys={new Set()}
        onSelect={noop}
        allCollapsed={false}
        onToggleAll={noop}
        className="min-h-0 flex-1"
      />
    ),
    header: pageHeader(
      commit?.subject ?? "Commit",
      <CommitBylineView commit={commit} hash={commit?.hash} />,
      {
        steps: <CommitStepsView onNewer={undefined} onOlder={noop} />,
        details: (
          <CommitDetailsView
            hash={commit?.hash ?? ""}
            description="The list keeps its order, so the filter is a plain substring match."
            onlyOn={undefined}
            busy={false}
            canAmend
            onAmend={noop}
            canReword
            onReword={noop}
            canSquash
            onSquash={noop}
            undoCount={1}
            onUndo={noop}
            canRevert
            onRevert={noop}
            pickTargets={[
              {
                id: "wt_sm_qq",
                branch: "port-pool-retry",
                name: "quiet-quail",
              },
            ]}
            onPick={noop}
            canCommand
            onNewWorktree={noop}
            dialog={null}
          />
        ),
      },
    ),
  });
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

// The pages' other pieces: their titles, the pane's other states, a
// hunk's bar, a commit only the remote has, and the phone's file sheet
// (closed: a sheet opens over the window).
export function DiffPartsScene() {
  const group = HUNKS.states.changes[0];
  return (
    <div className="grid h-full grid-cols-2 gap-6 overflow-hidden bg-background p-6 text-foreground">
      <div className="flex flex-col gap-5">
        <Part label="Titles">
          {pageHeader(
            <PullRequestDiffTitleView
              title="Aggregate worktrees across devices"
              number={148}
            />,
            <PullRequestDiffSubtitleView
              changedFiles={12}
              baseRefName="main"
              additions={340}
              deletions={96}
            />,
          )}
          {pageHeader(
            "All branch changes",
            <BranchDiffSubtitleView commits={4} base="origin/main" />,
          )}
          {pageHeader(
            "Commit",
            <CommitBylineView commit={undefined} hash="5eed5ab" />,
          )}
        </Part>
        <Part label="A commit only the upstream has">
          <CommitDetailsView
            hash="a41c9e2"
            description={undefined}
            onlyOn="origin/happy-hummingbird"
            busy={false}
            canAmend={false}
            onAmend={noop}
            canReword={false}
            onReword={noop}
            canSquash={false}
            onSquash={noop}
            undoCount={null}
            onUndo={noop}
            canRevert={false}
            onRevert={noop}
            pickTargets={[]}
            onPick={noop}
            canCommand={false}
            onNewWorktree={noop}
            dialog={null}
          />
        </Part>
        {group && (
          <Part label="A hunk's bar">
            <HunkBarView
              group={{ changes: [group], staged: "partial" }}
              controls={HUNKS}
              busy={false}
            />
          </Part>
        )}
        <Part label="A detached HEAD">
          <BranchBarView
            branch="5eed5ab"
            detached
            rebasing={false}
            syncPill={null}
          />
        </Part>
      </div>
      <div className="flex flex-col gap-5">
        <Part label="A clean tree">
          <div className="flex h-40 flex-col">
            <DiffPaneView
              state="empty"
              message={
                <CleanTreeMessageView
                  owed="2 commits not pushed yet."
                  shortcut="to push"
                />
              }
              virtualizer={null}
            >
              {null}
            </DiffPaneView>
          </div>
        </Part>
        <Part label="Computing">
          <div className="flex h-24 flex-col">
            <DiffPaneView state="loading" message={null} virtualizer={null}>
              {null}
            </DiffPaneView>
          </div>
        </Part>
        <Part label="Failed">
          <div className="flex h-24 flex-col">
            <DiffPaneView state="error" message={null} virtualizer={null}>
              {null}
            </DiffPaneView>
          </div>
        </Part>
        <Part label="A peer's foot">
          <ChangesFooterView
            branchBar={branchBar}
            lastCommit={null}
            composer={null}
            readOnlyNote={peerReadOnlyNote("Thinkpad")}
          />
        </Part>
        <DiffFilesSheetView
          open={false}
          onOpenChange={noop}
          title="Changed files"
        >
          {null}
        </DiffFilesSheetView>
      </div>
    </div>
  );
}
