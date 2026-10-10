// The transplant and mirror flows over the fixtures: Thinkpad's
// gentle-gecko transplanted here, brave-badger mirrored to a peer, the
// steps either flow goes through, a running mirror's dialog, and the
// mirror's marks on a worktree's header.
import type { ReactNode } from "react";
import { ArrowRight, type LucideIcon, RefreshCw } from "lucide-react";
import type { MirrorSession } from "@shigomori/contracts/modules/mirror";
import type { SyncIgnoredPathsResult } from "@shigomori/contracts/modules/sync";
import { ModalBox } from "../primitives/modal-shell.tsx";
import { changeEntries } from "../lib/patchFiles.ts";
import { worktreeTitle } from "../lib/worktreeTitle.ts";
import { MirrorConflictsChipView } from "../views/worktreeDetail/MirrorConflictsView.tsx";
import {
  MirrorLineView,
  MirrorPillView,
  MirrorStatusChipView,
} from "../views/worktreeDetail/MirrorPillView.tsx";
import { PullFlowFrameView } from "../views/worktreeDetail/flow/PullFlowFrameView.tsx";
import {
  LeaveOutPickerView,
  LeaveOutTrailingView,
} from "../views/worktreeDetail/flow/LeaveOutPickerView.tsx";
import { PullProgressView } from "../views/worktreeDetail/flow/PullProgressView.tsx";
import {
  CloneLinesView,
  DestinationCardView,
  type DestinationPick,
  LandingLinesView,
  type PeerTarget,
  PullReviewFooterView,
  PullReviewStepView,
  SetupRowView,
  SourceCardView,
} from "../views/worktreeDetail/flow/PullReviewView.tsx";
import {
  type FlowStage,
  LANDS_HERE,
  landsOnPeer,
} from "../views/worktreeDetail/flow/pullSteps.ts";
import {
  MirrorHeadlineView,
  MirrorLiveView,
} from "../views/worktreeDetail/mirror/MirrorDialogView.tsx";
import {
  MirrorHistoryListView,
  MirrorIgnoresApplyView,
  MirrorManageDialogView,
  MirrorPairStripView,
  type StopConfirm,
} from "../views/worktreeDetail/mirror/MirrorManageDialogView.tsx";
import { describeMirror } from "../views/worktreeDetail/mirror/mirrorStatus.ts";
import { TransplantHeadlineView } from "../views/worktreeDetail/transplant/TransplantDialogView.tsx";
import { TransplantFinishView } from "../views/worktreeDetail/transplant/TransplantFinishView.tsx";
import {
  CarryOverListView,
  ChangedFilesView,
  TransplantDetailsView,
} from "../views/worktreeDetail/transplant/TransplantReviewView.tsx";
import {
  pullLandingBranch,
  pullWorktreeName,
} from "@shigomori/contracts/git/branches";
import { createFakeChanges } from "../fixtures/changesFixtures.ts";
import {
  LOCAL_DEVICE_ID,
  MINI_ID,
  THINKPAD_ID,
  WORKPC_ID,
} from "../fixtures/fixtures.ts";
import {
  mirrorHistoryFixture,
  mirrorSessionFixture,
} from "../fixtures/mirrorFixtures.ts";
import { posedPullRequestDetail } from "../fixtures/pullRequestFixtures.ts";
import { deviceById, projectNamed, worktreeNamed } from "./world.ts";

const noop = () => {};
const HERE = deviceById(LOCAL_DEVICE_ID);
const THINKPAD = deviceById(THINKPAD_ID);
const MINI = deviceById(MINI_ID);
const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");
const TP_SM = projectNamed(THINKPAD_ID, "shigoto-no-mori");
const GECKO = worktreeNamed(TP_SM, "gentle-gecko");
const BADGER = worktreeNamed(SM, "brave-badger");
const GECKO_TITLE = worktreeTitle(GECKO, posedPullRequestDetail(GECKO.branch));
const WORKTREES_BASE = "~/.sm/wt/shigoto-no-mori";

const TRANSPLANT_STEPS = [
  "Review & destination",
  "Transplant",
  "Finish up source",
];
const MIRROR_STEPS = ["Review", "Mirror", "Live"];

// What the gitignored rule reads off a checkout.
const IGNORED: {
  data: SyncIgnoredPathsResult;
  isPending: false;
  isError: false;
} = {
  data: {
    paths: [
      "node_modules/",
      ".env.local",
      "dist/",
      "out/",
      ".vite/",
      "coverage/",
      ".DS_Store",
      "app/.electron-dev/",
    ],
    total: 8,
    patterns: ["node_modules/", ".env*.local", "dist/", "out/", ".vite/"],
  },
  isPending: false,
  isError: false,
};

// A flow dialog's frame (flow/PullFlowFrameView.tsx) on its surface.
function FlowDialog({
  stage,
  reviewIcon,
  title,
  headline,
  steps,
  children,
}: {
  stage: FlowStage;
  reviewIcon: LucideIcon;
  title: string;
  headline: ReactNode;
  steps: readonly string[];
  children: ReactNode;
}) {
  return (
    <ModalBox className="max-w-4xl">
      <PullFlowFrameView
        stage={stage}
        reviewIcon={reviewIcon}
        title={title}
        elapsed={14_000}
        headline={headline}
        steps={steps}
        stepsLabel="Steps"
        onClose={noop}
      >
        {children}
      </PullFlowFrameView>
    </ModalBox>
  );
}

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      {children}
    </section>
  );
}

// Thinkpad's gentle-gecko, on its way here: its changes travel, the
// carry-over is this machine's.
export function TransplantReviewScene() {
  const files = changeEntries(
    createFakeChanges(() => ({ ...GECKO })).status(GECKO.id),
  );
  return (
    <div className="h-full overflow-hidden bg-background p-6 text-foreground">
      <FlowDialog
        stage="review"
        reviewIcon={ArrowRight}
        title="Transplant worktree"
        steps={TRANSPLANT_STEPS}
        headline={
          <TransplantHeadlineView
            stage="review"
            branch={GECKO.branch}
            sourceDeviceLabel={THINKPAD.label}
            thisDeviceLabel={HERE.label}
            away={`off ${THINKPAD.label}`}
            running=""
          />
        }
      >
        <PullReviewStepView
          link="move"
          source={
            <SourceCardView
              heading="Source"
              title={GECKO_TITLE}
              pr={posedPullRequestDetail(GECKO.branch)}
              worktree={GECKO}
              projectName={TP_SM.name}
              sourceDeviceLabel={THINKPAD.label}
              icon={THINKPAD.icon}
              home="/home/rin"
            />
          }
          destination={
            <DestinationCardView
              heading="Destination"
              icon={HERE.icon}
              deviceLabel={HERE.label}
              target={{ project: SM }}
              toPeer={undefined}
              setup={
                <SetupRowView command="pnpm install" checked onChange={noop} />
              }
              lines={
                <LandingLinesView
                  title={GECKO_TITLE}
                  landingBranch={pullLandingBranch(GECKO)}
                  folder={pullWorktreeName(GECKO)}
                  refused={false}
                  base={WORKTREES_BASE}
                />
              }
            />
          }
          leaveOut={
            <LeaveOutPickerView
              value={{
                base: "everything",
                leftOut: new Set(["coverage/"]),
                brought: new Set(),
              }}
              onChange={noop}
              ignored={IGNORED}
              onBrowse={noop}
              browser={null}
            />
          }
          details={
            <TransplantDetailsView
              changes={
                <ChangedFilesView
                  files={files}
                  isPending={false}
                  isError={false}
                />
              }
              carryOver={
                <CarryOverListView
                  projectName={SM.name}
                  thisDeviceLabel={HERE.label}
                  rows={[
                    { path: ".env.local", tag: "manual" },
                    {
                      path: ".claude/settings.local.json",
                      tag: "worktreeinclude",
                    },
                  ]}
                  isPending={false}
                />
              }
            />
          }
          footer={
            <PullReviewFooterView
              refusal={null}
              unpicked={false}
              waiting={false}
              blocked={null}
              idleNote={`Nothing on ${THINKPAD.label} is deleted until you say so at the last step.`}
              startLabel="Start transplant"
              onCancel={noop}
              onStart={noop}
            />
          }
        />
      </FlowDialog>
    </div>
  );
}

const peerTarget = (
  deviceId: string,
  target: Pick<PeerTarget, "project" | "block">,
): PeerTarget => {
  const device = deviceById(deviceId);
  return {
    ...device,
    isThisDevice: false,
    ready: target.block === undefined,
    ...target,
  };
};

// brave-badger mirrored to the Mini, which has no checkout of the repo
// yet and clones it first, bringing one gitignored file along.
export function MirrorReviewScene() {
  const landing = landsOnPeer(MINI.label);
  const toPeer: DestinationPick = {
    targets: [
      peerTarget(MINI_ID, { project: undefined, block: undefined }),
      peerTarget(THINKPAD_ID, { project: TP_SM, block: "offline" }),
      peerTarget(WORKPC_ID, { project: undefined, block: "no-grant" }),
    ],
    pickedId: MINI_ID,
    onPick: noop,
  };
  return (
    <div className="h-full overflow-hidden bg-background p-6 text-foreground">
      <FlowDialog
        stage="review"
        reviewIcon={RefreshCw}
        title="Mirror worktree"
        steps={MIRROR_STEPS}
        headline={
          <MirrorHeadlineView
            stage="review"
            branch={BADGER.branch}
            landingBranch={pullLandingBranch(BADGER)}
            sourceDeviceLabel={HERE.label}
            on={landing.on}
            running=""
          />
        }
      >
        <PullReviewStepView
          link="mirror"
          source={
            <SourceCardView
              heading="Original"
              title={null}
              pr={null}
              worktree={BADGER}
              projectName={SM.name}
              sourceDeviceLabel={HERE.label}
              icon={HERE.icon}
              home="/Users/rin"
            />
          }
          destination={
            <DestinationCardView
              heading="Copy"
              icon={MINI.icon}
              deviceLabel={MINI.label}
              target={{
                clone: {
                  projectName: SM.name,
                  cloneInto: { parentDir: "~/Code/", name: "shigoto-no-mori" },
                  dest: "~/Code/shigoto-no-mori",
                  setParent: noop,
                },
              }}
              toPeer={toPeer}
              setup={null}
              lines={
                <CloneLinesView
                  clone={{
                    projectName: SM.name,
                    cloneInto: {
                      parentDir: "~/Code/",
                      name: "shigoto-no-mori",
                    },
                    dest: "~/Code/shigoto-no-mori",
                    setParent: noop,
                  }}
                  title={null}
                  worktree={BADGER}
                  onChange={noop}
                  picker={null}
                />
              }
            />
          }
          leaveOut={
            <LeaveOutPickerView
              value={{
                base: "gitignored",
                leftOut: new Set(),
                brought: new Set([".env.local"]),
              }}
              onChange={noop}
              ignored={IGNORED}
              onBrowse={noop}
              browser={null}
            />
          }
          footer={
            <PullReviewFooterView
              refusal={null}
              unpicked={false}
              waiting={false}
              blocked={null}
              idleNote=""
              startLabel="Start mirroring"
              onCancel={noop}
              onStart={noop}
            />
          }
        />
      </FlowDialog>
    </div>
  );
}

const PLAN = {
  carryOverCount: 2,
  setupCommand: "pnpm install",
  provisionsPorts: true,
};

// The steps after the review: a transplant mid-transfer, a mirror that
// stopped, a transplant landed with the source still to settle, and a
// mirror gone live.
export function FlowStepsScene() {
  const landed = {
    ...GECKO,
    path: `/Users/rin/.sm/wt/shigoto-no-mori/${GECKO.name}`,
  };
  const session = mirrorSessionFixture(BADGER, THINKPAD_ID, GECKO);
  return (
    <div className="grid h-full grid-cols-2 gap-6 overflow-hidden bg-background p-6 text-foreground">
      <div className="flex min-w-0 flex-col gap-6">
        <FlowDialog
          stage="running"
          reviewIcon={ArrowRight}
          title={`Transplanting to ${HERE.label}`}
          steps={TRANSPLANT_STEPS}
          headline={
            <TransplantHeadlineView
              stage="running"
              branch={GECKO.branch}
              sourceDeviceLabel={THINKPAD.label}
              thisDeviceLabel={HERE.label}
              away={`off ${THINKPAD.label}`}
              running={`Sending the branch and your changes from ${THINKPAD.label}.`}
            />
          }
        >
          <PullProgressView
            frame={{
              sourceWorktreeId: GECKO.id,
              step: "transfer",
              bytes: 1_240_000,
              totalBytes: 3_900_000,
            }}
            phasesSeen={new Set()}
            worktree={GECKO}
            target={{ project: SM }}
            sourceDeviceLabel={THINKPAD.label}
            thisDeviceLabel={HERE.label}
            runSetup
            onCancel={noop}
            onClose={noop}
            onRetry={noop}
            filesDetail="everything ignored, too"
            sourceIcon={THINKPAD.icon}
            destinationIcon={HERE.icon}
            plan={PLAN}
          />
        </FlowDialog>
        <FlowDialog
          stage="failed"
          reviewIcon={RefreshCw}
          title="Mirror didn't start"
          steps={MIRROR_STEPS}
          headline={
            <MirrorHeadlineView
              stage="failed"
              branch={BADGER.branch}
              landingBranch={BADGER.branch}
              sourceDeviceLabel={HERE.label}
              on={`on ${THINKPAD.label}`}
              running=""
            />
          }
        >
          <PullProgressView
            frame={{
              sourceWorktreeId: BADGER.id,
              step: "create",
              createPhase: "setup",
            }}
            phasesSeen={new Set(["carryOver", "setup"])}
            worktree={BADGER}
            target={{ project: TP_SM }}
            sourceDeviceLabel={HERE.label}
            thisDeviceLabel={THINKPAD.label}
            runSetup
            landing={landsOnPeer(THINKPAD.label)}
            error={new Error("setup exited with code 1: pnpm install failed")}
            onCancel={noop}
            onClose={noop}
            onRetry={noop}
            extraRows={[
              {
                title: "Match the files and open the mirror",
                detail: "both ways",
              },
            ]}
            sourcePart="source"
            progressLabel="Mirror progress"
            failedNote="Nothing was left behind, so trying again starts clean."
            sourceIcon={HERE.icon}
            destinationIcon={THINKPAD.icon}
            plan={PLAN}
          />
        </FlowDialog>
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        <FlowDialog
          stage="done"
          reviewIcon={ArrowRight}
          title="Transplant complete"
          steps={TRANSPLANT_STEPS}
          headline={
            <TransplantHeadlineView
              stage="done"
              branch={GECKO.branch}
              sourceDeviceLabel={THINKPAD.label}
              thisDeviceLabel={HERE.label}
              away={`off ${THINKPAD.label}`}
              running=""
            />
          }
        >
          <TransplantFinishView
            result={{
              worktree: landed,
              captured: true,
              dirtyApplied: true,
              files: { crossed: true, conflicts: 2 },
            }}
            path={
              <span className="truncate font-mono text-xs text-muted-foreground">
                {landed.path}
              </span>
            }
            sourceDeviceLabel={THINKPAD.label}
            thisDeviceLabel={HERE.label}
            landing={LANDS_HERE}
            choice="teardown"
            onChoose={noop}
            staying={0}
            error={null}
            kept={null}
            pending={false}
            armed={false}
            onClose={noop}
            onOpen={noop}
            onFinish={noop}
          />
        </FlowDialog>
        <FlowDialog
          stage="done"
          reviewIcon={RefreshCw}
          title="Mirror live"
          steps={MIRROR_STEPS}
          headline={
            <MirrorHeadlineView
              stage="done"
              branch={BADGER.branch}
              landingBranch={BADGER.branch}
              sourceDeviceLabel={HERE.label}
              on={`on ${THINKPAD.label}`}
              running=""
            />
          }
        >
          <MirrorLiveView
            branch={BADGER.branch}
            path={
              <span className="truncate font-mono text-xs text-muted-foreground">
                {session.remoteRoot}
              </span>
            }
            status={describeMirror(session)}
            summary="gitignored left out"
            sourceDeviceLabel={HERE.label}
            thisDeviceLabel={THINKPAD.label}
            dirtyApplied={false}
            onDone={noop}
          />
        </FlowDialog>
      </div>
    </div>
  );
}

const CONFLICTS: MirrorSession["conflicts"] = [
  {
    root: "renderer/index.css",
    localChanges: [{ path: "renderer/index.css", kind: "modified" }],
    remoteChanges: [{ path: "renderer/index.css", kind: "modified" }],
  },
  {
    root: "lab/scenes",
    localChanges: [
      { path: "lab/scenes/flows.tsx", kind: "created" },
      { path: "lab/scenes/index.ts", kind: "modified" },
    ],
    remoteChanges: [{ path: "lab/scenes", kind: "deleted" }],
  },
];

const NAMES = {
  runner: HERE.label,
  copy: THINKPAD.label,
  other: THINKPAD.label,
};

const STOP_IDLE: StopConfirm = {
  confirming: false,
  blocker: undefined,
  note: "",
  pending: false,
  ask: noop,
  cancel: noop,
  confirm: noop,
};

function manageDialog(
  session: MirrorSession,
  stop: StopConfirm,
  ruleChanged: boolean,
) {
  return (
    <ModalBox className="max-w-3xl">
      <MirrorManageDialogView
        session={session}
        view={describeMirror(session)}
        names={NAMES}
        revealUnder={undefined}
        canControl
        busy={false}
        resumable={session.paused}
        stop={stop}
        onPauseResume={noop}
        onClose={noop}
        pair={
          <MirrorPairStripView
            session={session}
            names={NAMES}
            runnerIcon={HERE.icon}
            copyIcon={THINKPAD.icon}
          />
        }
        ignores={
          <LeaveOutPickerView
            value={{
              base: "gitignored",
              leftOut: new Set(),
              brought: new Set(ruleChanged ? [".env.local"] : []),
            }}
            onChange={noop}
            ignored={IGNORED}
            onBrowse={noop}
            browser={null}
          >
            {ruleChanged && (
              <MirrorIgnoresApplyView
                pending={false}
                disabled={false}
                settled
                onApply={noop}
                onRevert={noop}
              />
            )}
          </LeaveOutPickerView>
        }
        history={
          <MirrorHistoryListView
            events={mirrorHistoryFixture()}
            isPending={false}
          />
        }
      />
    </ModalBox>
  );
}

// brave-badger's mirror with Thinkpad, two paths held still and its
// rule being changed, and the same mirror paused, its stop asked for
// before git agreed.
export function MirrorManageScene() {
  const copy = worktreeNamed(TP_SM, "gentle-gecko");
  const session = mirrorSessionFixture(BADGER, THINKPAD_ID, copy);
  return (
    <div className="grid h-full grid-cols-2 items-start gap-6 overflow-hidden bg-background p-6 text-foreground">
      {manageDialog({ ...session, conflicts: CONFLICTS }, STOP_IDLE, true)}
      {manageDialog(
        {
          ...session,
          paused: true,
          status: "disconnected",
          statusText: "Paused",
          git: {
            status: "diverged",
            detail: "Thinkpad has a commit the original lacks",
          },
        },
        {
          ...STOP_IDLE,
          confirming: true,
          blocker: "git has diverged",
          note: `Not confirmed in step: git has diverged. Removing the copy on ${THINKPAD.label} now loses anything only it holds.`,
        },
        false,
      )}
    </div>
  );
}

// The mirror's marks and the leave-out picker's rows in their other
// states.
export function FlowPartsScene() {
  const copy = worktreeNamed(TP_SM, "gentle-gecko");
  const session = {
    ...mirrorSessionFixture(BADGER, THINKPAD_ID, copy),
    conflicts: CONFLICTS,
  };
  const look = describeMirror(session);
  const trailing = { action: "Bring", done: "Brought" };
  return (
    <div className="grid h-full grid-cols-2 gap-6 overflow-hidden bg-background p-6 text-foreground">
      <div className="flex min-w-0 flex-col gap-5">
        <Part label="Mirror line">
          <MirrorPillView
            lines={
              <>
                <MirrorLineView
                  chip={
                    <MirrorStatusChipView tone="emerald" label="Mirrored" />
                  }
                  other={THINKPAD.label}
                />
                <MirrorLineView
                  chip={
                    <MirrorStatusChipView
                      tone="sky"
                      label="Syncing"
                      tip="Staging 12 files"
                      spinning
                    />
                  }
                  other={MINI.label}
                />
              </>
            }
          />
          <MirrorPillView
            lines={
              <MirrorLineView
                chip={
                  <MirrorConflictsChipView
                    session={session}
                    tone={look.tone}
                    label={look.label}
                    names={NAMES}
                  />
                }
                other={THINKPAD.label}
              />
            }
          />
        </Part>
        <Part label="Picker rows">
          <div className="flex flex-wrap items-center gap-2">
            <LeaveOutTrailingView
              picked
              ignored
              unreachable={false}
              full={false}
              copy={trailing}
              onPick={noop}
            />
            <LeaveOutTrailingView
              picked={false}
              ignored
              unreachable={false}
              full={false}
              copy={trailing}
              onPick={noop}
            />
            <LeaveOutTrailingView
              picked={false}
              ignored={false}
              unreachable={false}
              full={false}
              copy={trailing}
              onPick={noop}
            />
            <LeaveOutTrailingView
              picked={false}
              ignored
              unreachable
              full={false}
              copy={trailing}
              onPick={noop}
            />
            <LeaveOutTrailingView
              picked={false}
              ignored
              unreachable={false}
              full
              copy={trailing}
              onPick={noop}
            />
          </div>
        </Part>
        <Part label="Leave out, read-only and reading">
          <LeaveOutPickerView
            value={{
              base: "gitignored",
              leftOut: new Set(),
              brought: new Set([".env.local"]),
            }}
            onChange={noop}
            ignored={{ data: undefined, isPending: true, isError: false }}
            disabled
            note="Opens every mirror and transplant of this project."
            onBrowse={noop}
            browser={null}
          />
          <MirrorIgnoresApplyView
            pending={false}
            disabled
            settled={false}
            onApply={noop}
            onRevert={noop}
          />
        </Part>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <Part label="Reading">
          <ChangedFilesView files={[]} isPending isError={false} />
          <ChangedFilesView files={[]} isPending={false} isError />
          <CarryOverListView
            projectName={SM.name}
            thisDeviceLabel={HERE.label}
            rows={[]}
            isPending={false}
          />
          <MirrorHistoryListView events={undefined} isPending />
          <MirrorHistoryListView events={[]} isPending={false} />
        </Part>
        <Part label="A primary checkout's mirror">
          {(["review", "running", "cancelled", "done"] as const).map(
            (stage) => (
              <p key={stage} className="text-sm text-muted-foreground">
                <MirrorHeadlineView
                  stage={stage}
                  branch="main"
                  landingBranch="main-mirror"
                  sourceDeviceLabel={THINKPAD.label}
                  on="here"
                  running="Reaching the source."
                />
              </p>
            ),
          )}
          <p className="text-sm text-muted-foreground">
            <TransplantHeadlineView
              stage="cancelled"
              branch={GECKO.branch}
              sourceDeviceLabel={THINKPAD.label}
              thisDeviceLabel={HERE.label}
              away={`off ${THINKPAD.label}`}
              running=""
            />
          </p>
        </Part>
      </div>
    </div>
  );
}
