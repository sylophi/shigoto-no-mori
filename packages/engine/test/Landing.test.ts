// merge and land on a PR that doesn't merge on the spot: auto-merge
// armed, or a merge queue taking it. They wait until GitHub merges it,
// and stop with what the PR needs when it won't. Against real git and a
// scripted gh.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as Landing from "../src/Landing.ts";
import {
  mergeProblem,
  mergeWaitingOn,
  parseMergeProgress,
} from "../src/mergeProgress.ts";
import * as Registry from "../src/Registry.ts";
import * as Worktrees from "../src/Worktrees.ts";
import { type Engine, type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

// One read's answer: the PR's state, its verdict and review decision,
// whether auto-merge is armed, and its checks as name=conclusion pairs,
// an empty conclusion for a running check and a trailing ! for a
// required one.
function poll(
  state: string,
  verdict: string,
  review: string,
  armed: boolean,
  ...checks: string[]
): string {
  const nodes = checks.map((check) => {
    const [name = "", raw = ""] = check.split("=");
    const conclusion = raw.replace(/!$/, "");
    return {
      name,
      status: conclusion === "" ? "IN_PROGRESS" : "COMPLETED",
      conclusion,
      isRequired: raw.endsWith("!"),
    };
  });
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state,
          mergeStateStatus: verdict,
          reviewDecision: review,
          ...(armed ? { autoMergeRequest: { mergeMethod: "SQUASH" } } : {}),
          commits: {
            nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }],
          },
        },
      },
    },
  });
}

const QUEUED = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        state: "OPEN",
        mergeStateStatus: "BLOCKED",
        isInMergeQueue: true,
      },
    },
  },
});

// A gh for a one-PR land on a repo that allows auto-merge: the fox
// branch's PR #5 has `verdict` (BLOCKED: waiting on its checks), armed
// already with `armed`. Each read of the PR's progress (the read-back
// after a merge, then every poll of the wait) takes the next of
// `polls`, the last one answering every read after it. Every call is
// logged.
function fakeGh(
  polls: ReadonlyArray<string>,
  options: { readonly verdict?: string; readonly armed?: boolean } = {},
) {
  const log = join(box.home, "gh.log");
  const pollFile = join(box.home, "polls");
  writeFileSync(pollFile, `${polls.join("\n")}\n`);
  const auto = options.armed === true ? `{"mergeMethod":"SQUASH"}` : "null";
  box.fakeBin(
    "gh",
    `echo "$*" >> '${log}'
case "$*" in
  "pr list --state all --head fox --limit 10 --json "*) echo '[{"number":5,"title":"Fox","state":"OPEN","isDraft":false,"url":"u5","baseRefName":"main","headRefName":"fox","mergeStateStatus":"${options.verdict ?? "BLOCKED"}","autoMergeRequest":${auto}}]';;
  "api graphql -F number=5 "*)
    head -n 1 '${pollFile}'
    if [ "$(wc -l < '${pollFile}')" -gt 1 ]; then
      tail -n +2 '${pollFile}' > '${pollFile}.next' && mv '${pollFile}.next' '${pollFile}'
    fi;;
  "api graphql "*) echo '{"data":{"repository":{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"autoMergeAllowed":true}}}';;
  "pr merge 5 --auto --squash"|"pr merge 5 --squash") ;;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac`,
  );
  return {
    calls: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== ""),
    merges: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("pr merge ")),
  };
}

// A project cloned from an upstream, with a worktree `fox` a commit
// ahead on its own branch.
async function landFixture() {
  const upstream = box.repo("upstream", { "README.md": "hi\n" });
  const repo = join(box.home, "repo");
  execFileSync("git", ["clone", "-q", upstream, repo]);
  const located = await box.engine(
    Effect.gen(function* () {
      const project = yield* (yield* Registry.Registry).register({
        name: "repo",
        path: repo,
      });
      const worktrees = yield* Worktrees.Worktrees;
      const { worktree } = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      return yield* worktrees.resolve(yield* worktrees.here("/"), {
        projectId: project.id,
        worktreeId: worktree.id,
      });
    }),
  );
  const { worktree } = located as Worktrees.Located;
  box.git(worktree.path, "commit", "-q", "--allow-empty", "-m", "fox");
  return located as Worktrees.Located;
}

const quick = <A, E>(effect: Effect.Effect<A, E, Engine>) =>
  box.engine(
    Effect.provideService(
      effect,
      Landing.MergePollInterval,
      Duration.millis(1),
    ),
  );

const silent: Landing.Reporter = { report: () => Effect.void, color: false };

const land = (located: Worktrees.Located) =>
  quick(
    Effect.flatMap(Effect.service(Landing.Landing), (landing) =>
      landing.land(
        located,
        { force: false, keepBranch: false, skipCleanup: true, stack: false },
        silent,
      ),
    ),
  ) as Promise<Record<string, unknown>>;

const foxSurvives = async (located: Worktrees.Located) =>
  (
    (await box.engine(
      Effect.flatMap(Effect.service(Worktrees.Worktrees), (worktrees) =>
        worktrees.identities(located.project),
      ),
    )) as ReadonlyArray<Worktrees.WorktreeIdentity>
  ).some(({ branch }) => branch === "fox");

describe("waiting for GitHub to merge", () => {
  // A failing check GitHub doesn't require doesn't end the wait, and
  // once GitHub has merged the PR, land goes on to the cleanup.
  it("lands an armed PR once it merges", async () => {
    const located = await landFixture();
    const gh = fakeGh([
      poll("OPEN", "BLOCKED", "", true, "build=!", "lint=FAILURE"),
      poll("OPEN", "BLOCKED", "", true, "build=!", "lint=FAILURE"),
      poll("OPEN", "BLOCKED", "", true, "build=SUCCESS!", "lint=FAILURE"),
      poll("MERGED", "UNKNOWN", "", false),
    ]);
    const doc = await land(located);
    assert.equal(doc["ok"], true, JSON.stringify(doc));
    assert.deepEqual(gh.merges(), ["pr merge 5 --auto --squash"]);
    assert.equal(await foxSurvives(located), false);
  });

  // Landing again once it's dealt with arms nothing new and waits on
  // the armed auto-merge again.
  it("stops on a PR that needs attention, removing nothing", async () => {
    const located = await landFixture();
    fakeGh([
      poll("OPEN", "BLOCKED", "", true, "build=!"),
      poll("OPEN", "BLOCKED", "", true, "build=FAILURE!"),
    ]);
    const refused = await land(located);
    assert.equal(refused["code"], "needs-attention");
    assert.match(String(refused["error"]), /check build failed/);
    assert.equal(await foxSurvives(located), true);

    const gh = fakeGh(
      [
        poll("OPEN", "BLOCKED", "", true, "build=!"),
        poll("MERGED", "UNKNOWN", "", false),
      ],
      { armed: true },
    );
    assert.equal((await land(located))["ok"], true);
    // The first land's, and none since.
    assert.deepEqual(gh.merges(), ["pr merge 5 --auto --squash"]);
    assert.equal(await foxSurvives(located), false);
  });

  // On a base branch with a merge queue, a plain merge gh accepts queues
  // the PR, which land reads back and waits on.
  it("waits on a plain merge the queue took", async () => {
    const located = await landFixture();
    const gh = fakeGh([QUEUED, QUEUED, poll("MERGED", "UNKNOWN", "", false)], {
      verdict: "CLEAN",
    });
    assert.equal((await land(located))["ok"], true);
    assert.deepEqual(gh.merges(), ["pr merge 5 --squash"]);
    assert.equal(
      gh.calls().filter((call) => call.startsWith("api graphql -F number=5 "))
        .length,
      3,
    );
    assert.equal(await foxSurvives(located), false);
  });

  // gh's --auto merges at once when the verdict flipped since the
  // lookup, and the read-back says so.
  it("cleans up an auto-merge that merged at once", async () => {
    const located = await landFixture();
    const gh = fakeGh([poll("MERGED", "UNKNOWN", "", false)]);
    assert.equal((await land(located))["ok"], true);
    assert.deepEqual(gh.merges(), ["pr merge 5 --auto --squash"]);
    assert.equal(await foxSurvives(located), false);
  });

  it("merge waits too, and leaves the worktree to the cleanup", async () => {
    const located = await landFixture();
    // The read-back after the merge takes the first.
    fakeGh([
      poll("OPEN", "BLOCKED", "", true, "build=!"),
      poll("OPEN", "BLOCKED", "", true, "build=!"),
      poll("MERGED", "UNKNOWN", "", false),
    ]);
    const waiting: string[] = [];
    const doc = (await quick(
      Effect.flatMap(Effect.service(Landing.Landing), (landing) =>
        landing.merge(
          { located },
          { stack: false },
          {
            ...silent,
            waiting: (line) => Effect.sync(() => void waiting.push(line)),
          },
        ),
      ),
    )) as Record<string, unknown>;
    assert.equal(doc["outcome"], "merged");
    assert.deepEqual(waiting, [
      "waiting for GitHub to merge it: checks are running",
    ]);
    assert.equal(await foxSurvives(located), true);
  });

  // A read that falls between two of GitHub's steps (auto-merge gone,
  // the queue not shown yet) doesn't end the wait.
  it("rides out one read between two of GitHub's steps", async () => {
    const located = await landFixture();
    fakeGh([
      poll("OPEN", "BLOCKED", "", true, "build=!"),
      poll("OPEN", "BLOCKED", "", false),
      QUEUED,
      poll("MERGED", "UNKNOWN", "", false),
    ]);
    assert.equal((await land(located))["ok"], true);
  });

  // A PR that sits BLOCKED with nothing to wait on ends it, once it has
  // for a while.
  it("calls a PR stuck that sits blocked on nothing it can see", async () => {
    const located = await landFixture();
    fakeGh([poll("OPEN", "BLOCKED", "", true, "build=SUCCESS!")]);
    const refused = await land(located);
    assert.equal(refused["code"], "needs-attention");
    assert.match(String(refused["error"]), /can't see/);
  });
});

// What a read of the PR says it waits on, or needs a person for.
it("reads what a PR needs", () => {
  for (const [name, read, queued, problem, wait] of [
    [
      "checks running",
      poll("OPEN", "BLOCKED", "", true, "build=!", "lint=FAILURE"),
      false,
      "",
      "checks are running",
    ],
    [
      "review",
      poll("OPEN", "BLOCKED", "REVIEW_REQUIRED", true, "build=SUCCESS!"),
      false,
      "",
      "it needs a review",
    ],
    [
      "required check failed",
      poll("OPEN", "BLOCKED", "", true, "build=FAILURE!", "test=TIMED_OUT!"),
      false,
      "checks build, test failed",
      "",
    ],
    [
      "auto-merge turned off",
      poll("OPEN", "BLOCKED", "", false),
      false,
      "auto-merge was turned off",
      "",
    ],
    [
      "left the queue",
      poll("OPEN", "BLOCKED", "", false),
      true,
      "it left the merge queue unmerged",
      "",
    ],
    [
      "conflict",
      poll("OPEN", "DIRTY", "", true),
      false,
      "it conflicts with main",
      "",
    ],
    [
      "behind",
      poll("OPEN", "BEHIND", "", true),
      false,
      "it is behind main and needs updating",
      "",
    ],
    [
      "changes requested",
      poll("OPEN", "BLOCKED", "CHANGES_REQUESTED", true),
      false,
      "changes were requested",
      "",
    ],
    [
      "closed",
      poll("CLOSED", "UNKNOWN", "", false),
      false,
      "it was closed",
      "",
    ],
  ] as const) {
    const progress = parseMergeProgress(read);
    assert.ok(progress !== undefined, name);
    assert.equal(mergeProblem(progress, "main", queued), problem, name);
    if (problem === "") assert.equal(mergeWaitingOn(progress), wait, name);
  }

  // The queue brings a PR up to date itself.
  const queue = parseMergeProgress(
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: "OPEN",
            mergeStateStatus: "BEHIND",
            isInMergeQueue: true,
          },
        },
      },
    }),
  );
  assert.ok(queue !== undefined);
  assert.equal(mergeProblem(queue, "main", true), "");
  assert.equal(mergeWaitingOn(queue), "it is in the merge queue");
});

const mergedPr = (number: number, head: string, base: string) =>
  `{"number":${number},"title":"${head}","state":"MERGED","isDraft":false,"url":"u${number}","baseRefName":"${base}","headRefName":"${head}"}`;

// The primary checkout on a layer the stack landed stays, and the land
// says how it gets back on the trunk.
it("a stack land says when the primary checkout sits on a landed branch", async () => {
  const upstream = box.repo("upstream", { "README.md": "hi\n" });
  const repo = join(box.home, "repo");
  execFileSync("git", ["clone", "-q", upstream, repo]);
  box.git(repo, "checkout", "-q", "-b", "low");
  box.fakeBin(
    "gh",
    `case "$*" in
  "pr list --state all --head fox "*) echo '[${mergedPr(5, "fox", "low")}]';;
  "pr list --state all --limit 200 "*) echo '[${mergedPr(4, "low", "main")},${mergedPr(5, "fox", "low")}]';;
  "api graphql "*) echo '{"data":{"repository":{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":true,"autoMergeAllowed":true}}}';;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac`,
  );
  const notes: string[] = [];
  const doc = (await box.engine(
    Effect.gen(function* () {
      const project = yield* (yield* Registry.Registry).register({
        name: "repo",
        path: repo,
      });
      const worktrees = yield* Worktrees.Worktrees;
      const { worktree } = yield* worktrees.create(
        project,
        { name: "fox", skipSetup: true },
        { report: () => Effect.void, color: false },
      );
      const located = yield* worktrees.resolve(yield* worktrees.here("/"), {
        projectId: project.id,
        worktreeId: worktree.id,
      });
      return yield* (yield* Landing.Landing).land(
        located,
        { force: false, keepBranch: false, skipCleanup: true, stack: true },
        { ...silent, note: (line) => Effect.sync(() => void notes.push(line)) },
      );
    }),
  )) as Record<string, unknown>;
  assert.equal(doc["ok"], true);
  assert.deepEqual(notes, [
    "the primary checkout is on landed branch low. `smd done` lands it back on main",
  ]);
});
