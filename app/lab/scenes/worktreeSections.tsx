// The worktree page's sections over the fixtures (git, ports, scripts),
// for the page's scene, and the Git page's parts and the sections'
// other states in a scene of their own.
import type { ReactNode } from "react";
import { GitBranch } from "lucide-react";
import { StaticMenu } from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { ModalBox } from "@shigomori/ui/primitives/modal-shell.tsx";
import { TONE_PILL } from "@shigomori/ui/primitives/status-dot.tsx";
import {
  CardListView,
  CardSkeletonView,
  FlowBodyView,
  FlowFooterView,
  FlowHeaderView,
  StepRailView,
} from "@shigomori/ui/views/worktreeDetail/flow/FlowChromeView.tsx";
import {
  CommitMenuItemsView,
  CommitRowView,
} from "@shigomori/ui/views/worktreeDetail/git/CommitRowView.tsx";
import { GitPageSidebarView } from "@shigomori/ui/views/worktreeDetail/git/GitPageSidebarView.tsx";
import { GitSectionView } from "@shigomori/ui/views/worktreeDetail/git/GitSectionView.tsx";
import {
  BranchChangesRowView,
  EarlierToggleView,
  HistoryListView,
  NoteView,
  RefLineView,
  ShowMoreView,
  SplitHeaderView,
  UpToDateView,
} from "@shigomori/ui/views/worktreeDetail/git/HistoryListView.tsx";
import { MergeDialogView } from "@shigomori/ui/views/worktreeDetail/git/MergeDialogView.tsx";
import { OperationBannerView } from "@shigomori/ui/views/worktreeDetail/git/OperationBannerView.tsx";
import {
  RewordDialogView,
  RewordFormView,
} from "@shigomori/ui/views/worktreeDetail/git/RewordDialogView.tsx";
import { StashListView } from "@shigomori/ui/views/worktreeDetail/git/StashListView.tsx";
import { StashMovesView } from "@shigomori/ui/views/worktreeDetail/git/StashMovesView.tsx";
import type { CommitActions } from "@shigomori/ui/views/worktreeDetail/git/commitRewrite.ts";
import { ForwardAllButtonView } from "@shigomori/ui/views/worktreeDetail/ports/ForwardAllButtonView.tsx";
import { ForwardControlView } from "@shigomori/ui/views/worktreeDetail/ports/ForwardControlView.tsx";
import { OpenLocalhostButtonView } from "@shigomori/ui/views/worktreeDetail/ports/OpenLocalhostButtonView.tsx";
import {
  PortActionsView,
  PortListView,
} from "@shigomori/ui/views/worktreeDetail/ports/PortListView.tsx";
import {
  forwardBandClass,
  PortRowView,
} from "@shigomori/ui/views/worktreeDetail/ports/PortRowView.tsx";
import { PortsDialogView } from "@shigomori/ui/views/worktreeDetail/ports/PortsDialogView.tsx";
import { PortsSectionView } from "@shigomori/ui/views/worktreeDetail/ports/PortsSectionView.tsx";
import {
  ArrangeScriptRowView,
  ScriptDragPreviewView,
} from "@shigomori/ui/views/worktreeDetail/scripts/ArrangeScriptRowView.tsx";
import { PackageScriptsView } from "@shigomori/ui/views/worktreeDetail/scripts/PackageScriptsView.tsx";
import { ScriptListView } from "@shigomori/ui/views/worktreeDetail/scripts/ScriptListView.tsx";
import { ScriptRowView } from "@shigomori/ui/views/worktreeDetail/scripts/ScriptRowView.tsx";
import { ScriptsSectionView } from "@shigomori/ui/views/worktreeDetail/scripts/ScriptsSectionView.tsx";
import { SyncActionButtonView } from "@shigomori/ui/views/worktreeDetail/SyncActionButtonView.tsx";
import {
  HeldSyncView,
  PickSideView,
} from "@shigomori/ui/views/worktreeDetail/WorktreeSyncPillView.tsx";
import { NO_REWRITE } from "@/lib/commitRewrite";
import type { ScriptRunState } from "@shigomori/ui/lib/scriptRun.ts";
import type {
  ChangedFile,
  StashEntry,
  Worktree,
  WorktreePort,
} from "@shigomori/contracts/schemas";

const noop = () => {};
const resolved = async () => {};
const NOW = Date.now();
const MINUTE = 60_000;
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

const FILES: ChangedFile[] = [
  {
    path: "app/renderer/components/sidebar/CommitComposer.tsx",
    kind: "modified",
    counts: { additions: 31, deletions: 9 },
    staged: "none",
  },
  {
    path: "app/renderer/components/sidebar/DeviceBadge.tsx",
    kind: "modified",
    counts: { additions: 12, deletions: 4 },
    staged: "none",
  },
  {
    path: "app/renderer/lib/toast.tsx",
    kind: "modified",
    counts: { additions: 6, deletions: 2 },
    staged: "none",
  },
];

const STASHES: StashEntry[] = [
  {
    hash: "5f1e2d3",
    message: "Badge merged projects with their devices",
    named: false,
    date: ago(180),
  },
  {
    hash: "0a9b8c7",
    message: "Half a sort menu",
    named: true,
    date: ago(2880),
  },
];

const IDLE: ScriptRunState = {
  runId: null,
  status: "idle",
  hasOutput: false,
  interactive: false,
  exitCode: null,
  startedAt: null,
  endedAt: null,
  cancelling: false,
};

const PORTS: WorktreePort[] = [
  { port: 5173, label: "vite", source: "pool", listening: true },
  { port: 6006, source: "custom", listening: false },
];

// The list's moves, as the History tab hands them to each row.
const ACTIONS: CommitActions = {
  canCommand: true,
  undoTo: noop,
  canRevert: true,
  pickTargets: [],
  pending: false,
  revert: noop,
  cherryPickInto: noop,
  newWorktreeFrom: () => undefined,
  squash: noop,
  reword: noop,
  dialog: null,
};

const NAV = {
  toDiff: noop,
  toStash: noop,
  toCommit: noop,
  toBranchDiff: noop,
};

// The Git section of a worktree's page.
export function gitSection(worktree: Worktree) {
  return (
    <GitSectionView
      worktree={worktree}
      files={FILES}
      stashes={STASHES}
      commits={worktree.recentCommits}
      branch={{ base: "origin/main", own: 2, more: false }}
      syncPills={
        <SyncActionButtonView
          tone="emerald"
          label="Push 2 commits"
          pending={false}
          onClick={noop}
        />
      }
      operationBanner={null}
      nav={NAV}
    />
  );
}

function scriptRow(name: string, state = IDLE) {
  return (
    <ScriptRowView
      key={name}
      label={name}
      command={`pnpm ${name}`}
      state={state}
      busy={state.status === "running"}
      canRun
      disabledReason={undefined}
      onRun={noop}
      onStop={noop}
      onOpenConsole={noop}
    />
  );
}

// The Scripts section of a worktree's page.
export function scriptsSection() {
  return (
    <ScriptsSectionView
      loading={false}
      packageScripts={
        <PackageScriptsView
          sortMode="frequent"
          sorted={["dev", "test", "theme:check", "build"].map((name) => ({
            name,
            command: `pnpm ${name}`,
          }))}
          launchRow={["dev"]}
          canCommand
          onSort={noop}
          onArrange={noop}
          onReorder={noop}
          onPin={noop}
          renderRow={(entry) =>
            scriptRow(
              entry.name,
              entry.name === "dev"
                ? { ...IDLE, status: "running", startedAt: NOW - 4 * MINUTE }
                : IDLE,
            )
          }
        />
      }
      lifecycle={[
        scriptRow("Setup", {
          ...IDLE,
          status: "exited",
          exitCode: 0,
          startedAt: NOW - 90 * MINUTE,
          endedAt: NOW - 89 * MINUTE,
        }),
      ]}
    />
  );
}

function portRows(remote: boolean) {
  return PORTS.map((entry) => (
    <PortRowView
      key={entry.port}
      entry={entry}
      taken={PORTS}
      remote={remote}
      onUpdate={entry.source === "custom" ? resolved : undefined}
      onRemove={entry.source === "custom" ? noop : undefined}
      plain={!remote}
      forward={
        remote && (
          <ForwardControlView
            deviceLabel="Thinkpad"
            remotePort={entry.port}
            localPort={entry.port}
            live={entry.listening}
            pending={null}
            connCount={entry.listening ? 2 : 0}
            listening={entry.listening}
            granted
            error={null}
            onLocalPort={noop}
            onToggle={noop}
            className={forwardBandClass(false)}
          />
        )
      }
    />
  ));
}

// The Ports section of a worktree's page.
export function portsSection() {
  return (
    <PortsSectionView
      actions={
        <PortActionsView
          canEdit
          adding={false}
          atCap={false}
          canAdd
          onAdd={noop}
        />
      }
      list={
        <PortListView
          pending={false}
          failed={undefined}
          rows={portRows(false)}
          adding={false}
          taken={PORTS}
          onAdd={resolved}
          onAddDone={noop}
          plain
        />
      }
    />
  );
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

// The Git page's sidebar and dialogs, and the sections' other states.
export function WorktreeSectionsPartsScene({
  worktree,
}: {
  worktree: Worktree;
}) {
  const [newest, older] = worktree.recentCommits;
  return (
    <div className="grid h-full grid-cols-3 gap-6 overflow-hidden bg-background p-6 text-foreground">
      <div className="flex flex-col gap-5">
        <Part label="History">
          <div className="flex h-96 flex-col">
            <GitPageSidebarView
              tab="history"
              onTab={noop}
              changedCount={3}
              stashCount={STASHES.length}
              hasHistory
              banner={null}
              stashList={null}
              historyList={
                <HistoryListView
                  selected={newest ? `commit:${newest.hash}` : null}
                  search=""
                  onSearchChange={noop}
                  body={
                    <>
                      <BranchChangesRowView
                        base="origin/main"
                        own={2}
                        more={false}
                        onOpen={noop}
                      />
                      <SplitHeaderView
                        refLine={
                          <RefLineView
                            icon={<GitBranch className="size-3.5" />}
                            name="Split from origin"
                            tip="This branch and origin each have commits the other lacks"
                          />
                        }
                        side="here"
                        onSide={noop}
                        hereCount={2}
                        remoteLabel="origin 1"
                        pill={
                          <PickSideView
                            ahead={2}
                            behind={1}
                            compact
                            busy={false}
                            merge={{ pending: false, onClick: noop }}
                            pushForce={{
                              armed: false,
                              pending: false,
                              onClick: noop,
                            }}
                            overwrite={{
                              armed: false,
                              pending: false,
                              onClick: noop,
                            }}
                            onDisarm={noop}
                          />
                        }
                      />
                      {newest && (
                        <CommitRowView
                          commit={newest}
                          rewrite={NO_REWRITE}
                          actions={ACTIONS}
                          onOpen={noop}
                          onAmend={noop}
                        />
                      )}
                      {older && (
                        <CommitRowView
                          commit={older}
                          rewrite={NO_REWRITE}
                          actions={ACTIONS}
                          menu={false}
                          unpushed
                          onOpen={noop}
                          onAmend={noop}
                        />
                      )}
                      <RefLineView
                        icon={<GitBranch className="size-3.5" />}
                        name="origin/main"
                        mono
                        tip="Where this branch began"
                        action={<UpToDateView />}
                      />
                      <EarlierToggleView open onToggle={noop} />
                      <ShowMoreView pending={false} onLoad={noop} />
                      <NoteView>No commit messages match.</NoteView>
                    </>
                  }
                />
              }
            />
          </div>
        </Part>
        <Part label="Commit's moves">
          {newest && (
            <StaticMenu>
              <CommitMenuItemsView
                commit={newest}
                rewrite={{
                  canAmend: true,
                  reword: null,
                  squash: { head: newest.hash },
                  undo: {
                    target: "x",
                    count: 1,
                    head: newest.hash,
                    merge: false,
                  },
                }}
                actions={ACTIONS}
                onAmend={noop}
              />
            </StaticMenu>
          )}
        </Part>
      </div>
      <div className="flex flex-col gap-5">
        <Part label="Stashes">
          <div className="flex h-56 flex-col">
            <StashListView
              stashes={STASHES}
              selected={STASHES[0]?.hash}
              changedCount={3}
              canCommand
              message=""
              onMessageChange={noop}
              pending={false}
              onSubmit={noop}
              onPick={noop}
            />
          </div>
          <StashMovesView
            busy={false}
            onRestore={noop}
            onRestoreAndKeep={noop}
            onDrop={noop}
          />
        </Part>
        <Part label="Stopped">
          <OperationBannerView
            state={{
              operation: "rebase",
              continuable: false,
              conflicted: 2,
              rebasing: null,
            }}
            canCommand
            busy={false}
            onAbort={noop}
            onContinue={noop}
            onResolve={noop}
          />
        </Part>
        <Part label="Sync">
          <span className="flex flex-wrap items-center gap-2">
            <HeldSyncView
              held={{ label: "Pull waits", tip: "A script is running" }}
              compact={false}
            />
            <PickSideView
              ahead={2}
              behind={1}
              compact={false}
              busy={false}
              merge={{ pending: false, onClick: noop }}
              pushForce={{ armed: true, pending: false, onClick: noop }}
              overwrite={{ armed: false, pending: false, onClick: noop }}
              onDisarm={noop}
            />
          </span>
        </Part>
        <Part label="Merge">
          <ModalBox className="max-w-md">
            <MergeDialogView
              branch={worktree.branch}
              source="origin/main"
              from={null}
              method="squash"
              onMethod={noop}
              preview={{
                incoming: 4,
                own: 2,
                pushed: 1,
                ownMerges: 0,
                conflicts: ["app/renderer/index.css"],
                incomingSubject: "Show peers with control off as read-only",
              }}
              previewError={null}
              squashMessage="Show peers with control off as read-only"
              onSquashMessage={noop}
              mergeError={undefined}
              blocked="Commit or stash your changes first."
              pending={false}
              ready={false}
              onSubmit={noop}
              onCancel={noop}
            />
          </ModalBox>
        </Part>
      </div>
      <div className="flex flex-col gap-5">
        <Part label="Reword">
          <ModalBox className="max-w-lg">
            <RewordDialogView
              hash="7d02b18"
              form={
                <RewordFormView
                  summary="Aggregate worktrees across daemons"
                  onSummaryChange={noop}
                  description=""
                  onDescriptionChange={noop}
                  canSave
                  onSave={noop}
                  onCancel={noop}
                />
              }
            />
          </ModalBox>
        </Part>
        <Part label="Arranging scripts">
          <ScriptListView>
            <ArrangeScriptRowView name="dev" pinned onPin={noop} />
            <ArrangeScriptRowView name="test" pinned={false} onPin={noop} />
          </ScriptListView>
          <ScriptDragPreviewView name="dev" pinned />
        </Part>
        <Part label="A peer's ports">
          <ModalBox className="max-w-2xl">
            <PortsDialogView
              remote
              deviceLabel="Thinkpad"
              canForward
              list={
                <PortListView
                  pending={false}
                  failed={undefined}
                  rows={portRows(true)}
                  adding
                  taken={PORTS}
                  onAdd={resolved}
                  onAddDone={noop}
                />
              }
              actions={
                <ForwardAllButtonView
                  modes={["start", "stop"]}
                  runningMode={null}
                  canStart
                  startBlocker={undefined}
                  waiting={false}
                  onRun={noop}
                />
              }
              onClose={noop}
            />
          </ModalBox>
          <OpenLocalhostButtonView port={5173} />
        </Part>
        <Part label="A flow's frame">
          <FlowHeaderView
            tint={TONE_PILL.sky}
            icon={GitBranch}
            title="Transplant"
            onClose={noop}
          >
            <p>Move this worktree to another device.</p>
          </FlowHeaderView>
          <StepRailView
            current={1}
            steps={["Review", "Move", "Done"]}
            label="Transplant"
          />
          <FlowBodyView>
            <CardListView total={1}>
              {[<CardSkeletonView key="s" rows={2} />]}
            </CardListView>
          </FlowBodyView>
          <FlowFooterView>{null}</FlowFooterView>
        </Part>
      </div>
    </div>
  );
}
