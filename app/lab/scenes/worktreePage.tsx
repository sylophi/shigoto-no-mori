// A worktree's page over the fixtures: happy-hummingbird with its PR
// open, in a window beside the sidebar, and the states its footer and
// header go through.
import type { ReactNode } from "react";
import { WorktreeKindIconView } from "@shigomori/ui/views/shared/WorktreeKindIconView.tsx";
import { StaticMenu } from "@shigomori/ui/primitives/dropdown-menu.tsx";
import { StaticPopover } from "@shigomori/ui/primitives/popover.tsx";
import {
  AgentSessionsMenuView,
  SessionRowView,
} from "@/components/worktreeDetail/AgentSessionsMenuView";
import {
  BranchMenuView,
  BranchTitleView,
} from "@/components/worktreeDetail/branch/BranchTitleView";
import { BranchSwitcherView } from "@/components/worktreeDetail/branch/BranchSwitcherView";
import { DescriptionSectionView } from "@/components/worktreeDetail/DescriptionSectionView";
import { FooterActionButtonView } from "@/components/worktreeDetail/FooterActionButtonView";
import { LABEL_RANK } from "@/components/worktreeDetail/FooterVerbView";
import { LaunchSectionView } from "@/components/worktreeDetail/LaunchSectionView";
import { LauncherRowView } from "@/components/worktreeDetail/LauncherRowView";
import { NoIdentityNoteView } from "@/components/worktreeDetail/NoIdentityNoteView";
import { PullRequestTitleLinkView } from "@/components/worktreeDetail/pullRequests/PullRequestTitleLinkView";
import { PullRequestStateLabelView } from "@/components/worktreeDetail/pullRequests/PullRequestStateLabelView";
import {
  ScriptLaunchButtonView,
  ScriptLaunchRowView,
} from "@/components/worktreeDetail/ScriptLaunchRowView";
import { SortMenuView } from "@/components/worktreeDetail/SortMenuView";
import { WorktreeActivityIndicatorView } from "@/components/worktreeDetail/WorktreeActivityIndicatorView";
import {
  type WorktreeFooterState,
  WorktreeDetailFooterView,
} from "@/components/worktreeDetail/WorktreeDetailFooterView";
import {
  WorktreeDetailView,
  WorktreeUnavailableView,
} from "@/components/worktreeDetail/WorktreeDetailView";
import { WorktreeHeaderView } from "@/components/worktreeDetail/WorktreeHeaderView";
import { WorktreeLocationView } from "@/components/worktreeDetail/WorktreeLocationView";
import {
  OptionActionView,
  WorktreeOptionsView,
} from "@/components/worktreeDetail/WorktreeOptionsView";
import type {
  LauncherEntry,
  PullRequest,
  Worktree,
} from "@shigomori/contracts/schemas";
import { LOCAL_DEVICE_ID } from "../fake-host/fixtures";
import { unposedPullRequests } from "../fake-host/pullRequestFixtures";
import { SceneWindowFrame } from "./frame";
import { pullRequestLead } from "./pullRequests";
import { SceneSidebar } from "./sidebar";
import {
  gitSection,
  portsSection,
  scriptsSection,
  WorktreeSectionsPartsScene,
} from "./worktreeSections";
import { projectNamed, worktreeNamed } from "./world";

const noop = () => {};
const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");
const HUMMINGBIRD = worktreeNamed(SM, "happy-hummingbird");
const QUAIL = worktreeNamed(SM, "quiet-quail");
const PR = (
  unposedPullRequests(SM.id) as Record<string, PullRequest | undefined>
)["v2-exp/remote-ui-flows"];

const DESCRIPTION = `Lists every device's worktrees in one sidebar, each badged with the machine it lives on.

- The daemons' lists merge by repo identity.
- A peer that drops off keeps its last rows, faded.`;

const TOOLS: LauncherEntry[] = [
  { kind: "detected", id: "vscode", label: "VS Code", available: true },
  { kind: "detected", id: "terminal", label: "Terminal", available: true },
  { kind: "detected", id: "ghostty", label: "Ghostty", available: true },
  { kind: "web", id: "github", label: "GitHub" },
  { kind: "custom", id: "lazygit", label: "lazygit" },
];

function branchTitle(worktree: Worktree, subtitle: boolean) {
  return (
    <BranchTitleView
      branch={worktree.branch}
      detached={worktree.detached}
      subtitle={subtitle}
      menu={
        <BranchMenuView
          canCommand
          detached={worktree.detached}
          onRename={noop}
          onSwitch={noop}
          onCopy={noop}
          switcher={
            <BranchSwitcherView
              branch={worktree.branch}
              entries={[{ name: "main", kind: "local" }]}
              fetching={false}
              onPick={noop}
              anchorRef={{ current: null }}
              open={false}
              onOpenChange={noop}
            />
          }
        />
      }
    />
  );
}

function footer(state: WorktreeFooterState, worktree = HUMMINGBIRD) {
  const sessions = QUAIL.agentSessions ?? [];
  return (
    <WorktreeDetailFooterView
      worktree={worktree}
      state={state}
      actions={{
        onCancelCleanupError: noop,
        onOpenCleanupConsole: noop,
        onRetryCleanup: noop,
        onSkipCleanup: noop,
        onCancelForce: noop,
        onForceDelete: noop,
        onCancelCleanup: noop,
        onDelete: noop,
      }}
      leading={
        <FooterActionButtonView
          rank={LABEL_RANK.files}
          icon={null}
          label="Files"
          onClick={noop}
        />
      }
      agents={
        worktree === QUAIL && (
          <AgentSessionsMenuView
            sessions={sessions}
            rows={null}
            markIdle={{ disabled: false, onClick: noop }}
          />
        )
      }
      optionsMenu={
        <WorktreeOptionsView
          autoPull={{
            checked: false,
            can: true,
            disabled: false,
            onChange: noop,
          }}
          shelve={{ checked: false, disabled: false, onChange: noop }}
        />
      }
    />
  );
}

// happy-hummingbird's page: its PR open, named by the PR, launching.
export function WorktreePageScene() {
  return (
    <SceneWindowFrame
      sidebar={<SceneSidebar view="inbox" selected={HUMMINGBIRD.id} />}
    >
      <WorktreeDetailView
        projectName={SM.name}
        onConfigure={noop}
        location={
          <WorktreeLocationView
            path={HUMMINGBIRD.path}
            home="/Users/rin"
            rename={{
              editing: false,
              onEditingChange: noop,
              pending: false,
              onRename: noop,
            }}
          />
        }
        marks={
          <>
            <WorktreeActivityIndicatorView
              tip={null}
              spinning={false}
              onRefresh={noop}
            />
            <WorktreeKindIconView worktree={HUMMINGBIRD} allowAgentWorking />
          </>
        }
        face={null}
        header={
          PR && (
            <WorktreeHeaderView
              title={PR.title}
              pr={{
                titleLink: (
                  <PullRequestTitleLinkView
                    pr={PR}
                    aria-label={`Open pull request #${PR.number} on GitHub`}
                    data-no-hit-area
                    className="shrink-0 font-normal text-muted-foreground/60"
                  >
                    #{PR.number}
                  </PullRequestTitleLinkView>
                ),
                stateLabel: <PullRequestStateLabelView pr={PR} pill />,
                base: PR.baseRefName,
                mergeVerb: "Merges into",
              }}
              branchTitle={branchTitle(HUMMINGBIRD, true)}
              diff={{
                changedFiles: 14,
                additions: 412,
                deletions: 96,
                onClick: noop,
              }}
            />
          )
        }
        mirrorPill={null}
        banner={null}
        locked={false}
        prLead={pullRequestLead()}
        description={
          <DescriptionSectionView
            description={DESCRIPTION}
            expanded={false}
            onToggle={noop}
            truncated={false}
          />
        }
        launch={
          <LaunchSectionView
            tools={
              <LauncherRowView
                entries={TOOLS}
                onLaunch={noop}
                onChooseTools={noop}
                onConfigure={noop}
              />
            }
            scripts={
              <ScriptLaunchRowView
                pinned={false}
                buttons={["dev", "test", "theme:check"].map((name) => (
                  <ScriptLaunchButtonView
                    key={name}
                    name={name}
                    command={`pnpm ${name}`}
                    busy={name === "dev"}
                    disabled={false}
                    disabledReason={undefined}
                    onClick={noop}
                  />
                ))}
                measure={{ names: ["dev", "test", "theme:check"] }}
              />
            }
          />
        }
        git={gitSection(HUMMINGBIRD)}
        ports={portsSection()}
        scripts={scriptsSection()}
        footer={footer({
          kind: "normal",
          confirmDelete: false,
          busy: false,
          deleteBlockedReason: undefined,
        })}
      />
    </SceneWindowFrame>
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

// The page's parts in their other states: untitled work under its
// branch, a rename, removal and its failures, a page locked by a
// create, the tools' empty states, and the menus drawn open.
export function WorktreePagePartsScene() {
  return (
    <div className="grid h-full grid-cols-2 gap-6 overflow-hidden bg-background p-6 text-foreground">
      <div className="flex flex-col gap-5">
        <Part label="Untitled">{branchTitle(QUAIL, false)}</Part>
        <Part label="Renaming">
          <BranchTitleView
            branch={QUAIL.branch}
            detached={false}
            editing={{
              draft: "port-pool-retry-2",
              onDraftChange: noop,
              pending: false,
              error: "A branch named port-pool-retry-2 already exists.",
              onCommit: noop,
              onCancel: noop,
            }}
            menu={null}
          />
        </Part>
        <Part label="Renaming the folder">
          <div className="flex text-xs text-muted-foreground">
            <WorktreeLocationView
              path={QUAIL.path}
              home="/Users/rin"
              rename={{
                editing: true,
                onEditingChange: noop,
                pending: false,
                onRename: noop,
              }}
            />
          </div>
        </Part>
        <Part label="Footer">
          {footer({ kind: "cleanupRunning", cancelling: false })}
          {footer({
            kind: "needsForce",
            errorMessage: undefined,
            busy: false,
          })}
          {footer({
            kind: "cleanupError",
            error: { phase: "teardown", exitCode: 1, runId: "run-1" },
          })}
          {footer(
            {
              kind: "normal",
              confirmDelete: true,
              busy: false,
              deleteBlockedReason: undefined,
            },
            QUAIL,
          )}
          <WorktreeDetailFooterView
            worktree={HUMMINGBIRD}
            state={{
              kind: "normal",
              confirmDelete: false,
              busy: false,
              deleteBlockedReason: undefined,
            }}
            actions={{
              onCancelCleanupError: noop,
              onOpenCleanupConsole: noop,
              onRetryCleanup: noop,
              onSkipCleanup: noop,
              onCancelForce: noop,
              onForceDelete: noop,
              onCancelCleanup: noop,
              onDelete: noop,
            }}
            leading={<NoIdentityNoteView />}
            canMutate={false}
            optionsMenu={null}
          />
        </Part>
        <Part label="Tools">
          <LauncherRowView
            entries={undefined}
            onLaunch={noop}
            onChooseTools={noop}
            onConfigure={noop}
          />
          <LauncherRowView
            entries={[]}
            allHidden
            onLaunch={noop}
            onChooseTools={noop}
            onConfigure={noop}
          />
          <LaunchSectionView scripts={null} scriptsLoading />
          <SortMenuView value="frequent" onChange={noop} onArrange={noop} />
        </Part>
      </div>
      <div className="flex flex-col gap-5">
        <Part label="Agents">
          <StaticMenu className="w-80">
            {(QUAIL.agentSessions ?? []).map((session) => (
              <SessionRowView
                key={session.session}
                session={session}
                resumable={false}
                resumeDisabled={false}
                unbindDisabled={false}
                onResume={noop}
                onUnbind={noop}
              />
            ))}
          </StaticMenu>
        </Part>
        <Part label="Options">
          <StaticPopover>
            <OptionActionView
              icon={null}
              label="Transplant"
              description="Move this worktree to another device."
              onClick={noop}
            />
          </StaticPopover>
        </Part>
        <Part label="A create, locking the page">
          <div className="h-48 overflow-hidden rounded-lg border border-border">
            <WorktreeDetailView
              projectName={SM.name}
              onConfigure={noop}
              location={
                <WorktreeLocationView path={QUAIL.path} home="/Users/rin" />
              }
              marks={null}
              face={null}
              header={branchTitle(QUAIL, false)}
              mirrorPill={null}
              banner="Copying files into the worktree..."
              locked
              launch={null}
              git={null}
              ports={null}
              scripts={null}
              footer={null}
            />
          </div>
        </Part>
        <Part label="No worktree">
          <div className="h-24">
            <WorktreeUnavailableView onRetry={noop} />
          </div>
          <div className="h-16">
            <WorktreeUnavailableView />
          </div>
        </Part>
      </div>
    </div>
  );
}

// The Git page's parts, and the worktree page's sections in their other
// states.
export function WorktreeSectionsScene() {
  return <WorktreeSectionsPartsScene worktree={HUMMINGBIRD} />;
}
