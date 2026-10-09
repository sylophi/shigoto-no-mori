// A worktree's pull request over the fixtures: the merge box in the
// states its PR goes through, the section a PR gets on a page not named
// by it, with the stack it sits in, and the boxes that clean up after a
// PR closed or merged.
import type { ReactNode } from "react";
import { StaticPopover } from "@/components/ui/popover";
import { CheckEntryView } from "@/components/worktreeDetail/pullRequests/CheckEntryView";
import { ClosedPullRequestBoxView } from "@/components/worktreeDetail/pullRequests/ClosedPullRequestBoxView";
import {
  type MergeControls,
  MergeBoxView,
} from "@/components/worktreeDetail/pullRequests/MergeBoxView";
import { MergedPrimaryBranchBoxView } from "@/components/worktreeDetail/pullRequests/MergedPrimaryBranchBoxView";
import { PullRequestBodyView } from "@/components/worktreeDetail/pullRequests/PullRequestBodyView";
import { PullRequestIdentityView } from "@/components/worktreeDetail/pullRequests/PullRequestIdentityView";
import { PullRequestSectionView } from "@/components/worktreeDetail/pullRequests/PullRequestSectionView";
import { StackListView } from "@/components/worktreeDetail/pullRequests/StackListView";
import {
  armsAutoMerge,
  autoMergeButtonLabel,
  describeArmedAutoMerge,
  describeMergeState,
  describeMergeVerdict,
  sortChecksWorstFirst,
} from "@/lib/pullRequest";
import { pullRequestStackFor } from "@shared/pullRequestStack";
import type {
  PullRequest,
  PullRequestDetail,
} from "@shigomori/contracts/schemas";
import { LOCAL_DEVICE_ID, THINKPAD_ID } from "../fake-host/fixtures";
import {
  FAKE_REPO_MERGE_CONFIG,
  posedPullRequestDetail,
  unposedPullRequests,
} from "../fake-host/pullRequestFixtures";
import { projectNamed, worktreeNamed } from "./world";

const noop = () => {};
const SM = projectNamed(LOCAL_DEVICE_ID, "shigoto-no-mori");
const GECKO = worktreeNamed(
  projectNamed(THINKPAD_ID, "shigoto-no-mori"),
  "gentle-gecko",
);
const PRS: Record<string, PullRequest> = unposedPullRequests(SM.id);
const OWN_BRANCH = "v2-exp/remote-ui-flows";

// A branch's PR as the fake host poses it by the same query.
function detail(branch: string, query = ""): PullRequestDetail {
  const pr = posedPullRequestDetail(branch, query);
  if (!pr) throw new Error(`no fixture pull request for ${branch}`);
  return pr;
}

// The merge box as the MergeBox container draws it for `pr`, squash
// being the repo's method, with `controls` over what it would work out.
function mergeBox(
  pr: PullRequestDetail,
  controls: Partial<MergeControls> | null = {},
  hasMethod = true,
) {
  const mode =
    pr.autoMerge !== null
      ? "armed"
      : armsAutoMerge(FAKE_REPO_MERGE_CONFIG, pr, false)
        ? "arm"
        : "merge";
  const state = describeMergeState(pr.mergeState, pr.isDraft, mode === "arm");
  const status =
    pr.autoMerge !== null ? describeArmedAutoMerge(pr.autoMerge) : state;
  return (
    <MergeBoxView
      pr={pr}
      hasMethod={hasMethod}
      verdict={describeMergeVerdict(pr, status, mode === "armed")}
      compact={{ reviews: false, status: false }}
      merge={
        controls && {
          mode,
          label:
            mode === "arm"
              ? autoMergeButtonLabel("squash")
              : "Squash and merge",
          pendingLabel: mode === "arm" ? "Enabling auto-merge…" : "Merging…",
          landsStack: false,
          blocked: null,
          disabled: !state.canMerge,
          pending: false,
          armed: false,
          onMerge: noop,
          others: mode === "armed" ? [] : ["merge", "rebase"],
          onPickMethod: noop,
          draftPending: false,
          onToggleDraft: noop,
          disablePending: false,
          onDisableAutoMerge: noop,
          error: undefined,
          disableError: undefined,
          draftError: undefined,
          ...controls,
        }
      }
    />
  );
}

// happy-hummingbird's page leads with its PR's merge box.
export function pullRequestLead() {
  return <PullRequestBodyView mergeBox={mergeBox(detail(OWN_BRANCH))} />;
}

function closedBox(
  props: Partial<Parameters<typeof ClosedPullRequestBoxView>[0]>,
) {
  return (
    <ClosedPullRequestBoxView
      count={1}
      reach="one"
      armed={false}
      deletePending={false}
      stackPending={false}
      blockedNote={null}
      stackError={null}
      deleteError={null}
      onDelete={noop}
      onDeleteStack={noop}
      onRunStack={noop}
      onPickReach={noop}
      onDismissStackError={noop}
      {...props}
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

export function PullRequestPartsScene() {
  const gecko = detail(GECKO.branch);
  const stack = pullRequestStackFor(PRS, GECKO.branch, "main");
  const many = detail(OWN_BRANCH, "checks=many");
  return (
    <div className="grid h-full grid-cols-2 gap-6 overflow-hidden bg-background p-6 text-foreground">
      <div className="flex min-w-0 flex-col gap-5">
        <Part label="A stacked PR, on a page not named by it">
          <PullRequestSectionView
            identity={
              <PullRequestIdentityView
                pr={gecko}
                now={Date.now()}
                showUpdated
                onOpenDiff={noop}
              />
            }
            stackList={
              stack && <StackListView worktree={GECKO} stack={stack} />
            }
            body={
              <PullRequestBodyView
                mergeBox={mergeBox(gecko, {
                  label: "Squash and merge up to here (2)",
                  pendingLabel: "Merging stack…",
                  landsStack: true,
                  reach: { value: "upTo", onPick: noop },
                })}
              />
            }
          />
        </Part>
        <Part label="Waiting on checks">
          {mergeBox(detail(OWN_BRANCH, "checks=pending"))}
        </Part>
        <Part label="Failing, with reviews asked for">
          {mergeBox(detail(OWN_BRANCH, "checks=failing&reviews=required"))}
        </Part>
        <Part label="A draft, confirming, failed">
          {mergeBox(detail(OWN_BRANCH, "prState=draft"), {
            armed: true,
            error: "GraphQL: Pull request is still a draft (mergePullRequest)",
          })}
        </Part>
        <Part label="Conflicting, read-only">
          {mergeBox(detail(OWN_BRANCH, "prState=conflicts"), null)}
        </Part>
        <Part label="No merge methods">
          {mergeBox(detail(OWN_BRANCH, "reviews=approved"), null, false)}
        </Part>
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <Part label="Closed">
          {closedBox({})}
          {closedBox({
            count: 3,
            reach: "stack",
            armed: true,
            blockedNote: "1 more on Thinkpad, which is offline.",
          })}
          {closedBox({
            count: 3,
            stackError: {
              kind: "cleanup",
              message: "Thinkpad: teardown exited with code 1",
            },
          })}
          {closedBox({
            count: 3,
            stackError: {
              kind: "error",
              message: "MacBook: brave-badger has uncommitted changes",
            },
            deleteError: "The worktree is locked by a running create.",
          })}
        </Part>
        <Part label="Merged, on the main checkout">
          <MergedPrimaryBranchBoxView
            target="main"
            armed={false}
            pending={false}
            onClick={noop}
          />
        </Part>
        <Part label="Checks">
          <StaticPopover className="w-80">
            <ul className="max-h-80 space-y-0.5 overflow-y-auto">
              {sortChecksWorstFirst(many.checkList).map((check) => (
                <li key={`${check.name}::${check.url ?? ""}`}>
                  <CheckEntryView check={check} />
                </li>
              ))}
            </ul>
          </StaticPopover>
        </Part>
      </div>
    </div>
  );
}
