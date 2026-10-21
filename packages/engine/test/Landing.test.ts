// merge and land on a PR that doesn't merge on the spot: auto-merge
// armed, or a merge queue taking it. They wait until GitHub merges it,
// and stop with what the PR needs when it won't. Against real git and a
// scripted gh.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as Config from "../src/Config.ts";
import * as GitHub from "../src/GitHub.ts";
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
// `polls`, the last one answering every read after it. `onMerge` runs
// as gh merges. Every call is logged.
function fakeGh(
  polls: ReadonlyArray<string>,
  options: {
    readonly verdict?: string;
    readonly armed?: boolean;
    readonly onMerge?: string;
  } = {},
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
  "pr merge 5 --auto --squash"|"pr merge 5 --squash") ${options.onMerge ?? ""};;
  "pr view 5 --json headRefOid") printf '{"headRefOid":"%s"}' "$(cat '${headFile()}')";;
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

// Where the fakes read the commit PR #5's head is at on GitHub.
const headFile = () => join(box.home, "pr-5-head");

// A project cloned from an upstream holding this repository, with a
// worktree `fox` a commit ahead on its own branch, pushed: PR #5's head
// is that commit.
async function landFixture() {
  const upstream = box.realRepo("upstream");
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
      return yield* worktrees.resolve(yield* worktrees.nowhere, {
        projectId: project.id,
        worktreeId: worktree.id,
      });
    }),
  );
  const { worktree } = located as Worktrees.Located;
  box.git(worktree.path, "commit", "-q", "--allow-empty", "-m", "fox");
  writeFileSync(headFile(), box.git(worktree.path, "rev-parse", "HEAD").trim());
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
  "pr view 5 --json headRefOid") printf '{"headRefOid":"%s"}' "$(git -C '${repo}' rev-parse low)";;
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
      const located = yield* worktrees.resolve(yield* worktrees.nowhere, {
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

// The branch goes with the land, so commits the PR's head never had (made
// after its last push, or under a name an older PR merged with) are
// refused, named, before anything is merged or removed.
describe("commits the pull request never had", () => {
  it("land refuses to delete them, naming them, before anything merges", async () => {
    const located = await landFixture();
    const gh = fakeGh([poll("MERGED", "UNKNOWN", "", false)]);
    box.git(
      located.worktree.path,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "late",
    );
    const doc = await land(located);
    assert.equal(doc["ok"], false);
    assert.equal(doc["code"], "unpushed-commits");
    assert.match(
      String(doc["error"]),
      /^Branch fox has a commit PR #5 doesn't have, which landing would delete: [0-9a-f]+ late\. Push them to the PR first\.$/,
    );
    assert.equal(doc["hint"], "Pass --force to discard them.");
    assert.deepEqual(gh.merges(), [], "nothing merged");
    assert.equal(await foxSurvives(located), true);
  });

  it("land refuses them after a merge GitHub answered at once", async () => {
    const located = await landFixture();
    const gh = fakeGh([poll("MERGED", "UNKNOWN", "", false)], {
      onMerge: `git -C '${located.worktree.path}' commit -q --allow-empty -m late`,
    });
    const doc = await land(located);
    assert.equal(doc["code"], "unpushed-commits", JSON.stringify(doc));
    assert.match(
      String(doc["error"]),
      /^Branch fox has a commit its merged PR #5 never had, which removing it would delete: [0-9a-f]+ late\. Push them to a new PR first\.$/,
    );
    assert.equal(
      doc["hint"],
      "Pass --force to discard them, or --keep-branch to keep the branch.",
    );
    assert.deepEqual(gh.merges(), ["pr merge 5 --auto --squash"]);
    assert.equal(await foxSurvives(located), true);
    assert.match(
      box.git(located.project.path, "log", "-1", "--format=%s", "fox"),
      /^late/,
    );
  });

  it("land leaves them be when the removal keeps the branch", async () => {
    const located = await landFixture();
    fakeGh([poll("MERGED", "UNKNOWN", "", false)]);
    await box.engine(
      Effect.flatMap(Effect.service(Config.Config), (config) =>
        config.set({ kind: "device" }, "deleteBranchOnRemove", "false"),
      ),
    );
    box.git(
      located.worktree.path,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "late",
    );
    const doc = await land(located);
    assert.equal(doc["ok"], true, JSON.stringify(doc));
    assert.match(
      box.git(located.project.path, "log", "-1", "--format=%s", "fox"),
      /^late/,
    );
  });

  const done = (located: Worktrees.Located) =>
    box.engine(
      Effect.flatMap(Effect.service(Landing.Landing), (landing) =>
        landing.done(located, { force: false }),
      ),
    ) as Promise<Record<string, unknown>>;
  const mergedGh = (said: string) =>
    box.fakeBin(
      "gh",
      `case "$*" in
  "pr list --state merged --head fox "*) ${said};;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac`,
    );

  it("done refuses a branch its merged PR doesn't hold whole, and says when GitHub couldn't be asked", async () => {
    const located = await landFixture();
    const head = readFileSync(headFile(), "utf8");
    mergedGh(`echo '[{"number":5,"headRefOid":"${head}"}]'`);
    box.git(
      located.worktree.path,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "late",
    );
    const unpushed = await done(located);
    assert.equal(
      unpushed["code"],
      "unpushed-commits",
      JSON.stringify(unpushed),
    );
    assert.match(
      String(unpushed["error"]),
      /^Branch fox has a commit its merged PR #5 never had, which deleting it would lose: [0-9a-f]+ late\. Push them to a new PR first\.$/,
    );
    assert.equal(unpushed["hint"], "Pass --force to discard them.");

    mergedGh(`echo 'error connecting to api.github.com' >&2; exit 1`);
    const unasked = await done(located);
    assert.equal(unasked["ok"], false, JSON.stringify(unasked));
    assert.match(
      String(unasked["error"]),
      /^Couldn't ask GitHub whether fox was merged\. Try again once gh can reach it\. gh said: .*error connecting to api\.github\.com/,
    );
    assert.equal(unasked["hint"], "Pass --force to discard the branch.");
    assert.equal(await foxSurvives(located), true);
  });

  // The checkout runs the user's hooks, so an interrupt reaches it: a
  // hook that never ends doesn't hold a done that was asked to stop.
  it("done stops when interrupted in a checkout hook that never ends, and still deletes the branch it freed", async () => {
    const upstream = box.repo("upstream", { "README.md": "hi\n" });
    const repo = join(box.home, "repo");
    execFileSync("git", ["clone", "-q", upstream, repo]);
    box.git(repo, "checkout", "-q", "-b", "fox");
    box.git(repo, "commit", "-q", "--allow-empty", "-m", "fox");
    const head = box.git(repo, "rev-parse", "HEAD").trim();
    mergedGh(`echo '[{"number":5,"headRefOid":"${head}"}]'`);
    const started = join(box.home, "hook-started");
    const finished = join(box.home, "hook-finished");
    writeFileSync(
      join(repo, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\ntouch '${started}'\nsleep 30\ntouch '${finished}'\n`,
      { mode: 0o755 },
    );
    await box.engine(
      Effect.gen(function* () {
        yield* (yield* Registry.Registry).register({
          name: "repo",
          path: repo,
        });
        const worktrees = yield* Worktrees.Worktrees;
        const located = yield* worktrees.resolve(
          yield* worktrees.here(repo),
          {},
        );
        const landing = yield* Landing.Landing;
        const fiber = yield* Effect.forkChild(
          landing.done(located, { force: false }),
        );
        while (!existsSync(started)) yield* Effect.sleep("20 millis");
        yield* Fiber.interrupt(fiber);
      }),
    );
    assert.equal(
      existsSync(finished),
      false,
      "the interrupt waited on the hook",
    );
    // git moved HEAD before the hook ran, so the branch went all the same:
    // a done again from the primary branch would find nothing to delete.
    assert.equal(
      box.git(repo, "branch", "--list", "fox").trim(),
      "",
      "the merged branch left behind",
    );
  });

  // A hook that failed after the checkout freed the branch, and a
  // delete that failed too: both are said, where a report showed one.
  it("done says both a failed hook and a branch it couldn't delete", async () => {
    const upstream = box.repo("upstream", { "README.md": "hi\n" });
    const repo = join(box.home, "repo");
    execFileSync("git", ["clone", "-q", upstream, repo]);
    box.git(repo, "checkout", "-q", "-b", "fox");
    box.git(repo, "commit", "-q", "--allow-empty", "-m", "fox");
    const head = box.git(repo, "rev-parse", "HEAD").trim();
    mergedGh(`echo '[{"number":5,"headRefOid":"${head}"}]'`);
    writeFileSync(
      join(repo, ".git", "hooks", "post-checkout"),
      "#!/bin/sh\necho 'the hook broke' >&2\nexit 1\n",
      { mode: 0o755 },
    );
    writeFileSync(join(repo, ".git", "refs", "heads", "fox.lock"), "");
    const said = (await box.engine(
      Effect.gen(function* () {
        yield* (yield* Registry.Registry).register({
          name: "repo",
          path: repo,
        });
        const worktrees = yield* Worktrees.Worktrees;
        const located = yield* worktrees.resolve(
          yield* worktrees.here(repo),
          {},
        );
        return yield* (yield* Landing.Landing).done(located, { force: false });
      }),
    )) as { ok: boolean; error: string };
    assert.equal(said.ok, false);
    assert.match(said.error, /post-checkout|the hook broke|hook/);
    assert.match(said.error, /fox couldn't be deleted/);
  });

  // What decides the delete is where HEAD ends up, read in full: a hook
  // that moves it on keeps the branch, and a tag of the primary's name
  // doesn't hide that HEAD is on the primary.
  it.each([
    ["a hook that detaches HEAD and succeeds keeps the branch", "detach", true],
    [
      "a failing hook beside a tag of the primary's name still deletes it",
      "tag",
      false,
    ],
  ])("done: %s", async (_name, kind, kept) => {
    const upstream = box.repo("upstream", { "README.md": "hi\n" });
    const repo = join(box.home, "repo");
    execFileSync("git", ["clone", "-q", upstream, repo]);
    const primary = box.git(repo, "branch", "--show-current").trim();
    if (kind === "tag") box.git(repo, "tag", primary);
    box.git(repo, "checkout", "-q", "-b", "fox");
    box.git(repo, "commit", "-q", "--allow-empty", "-m", "fox");
    const head = box.git(repo, "rev-parse", "HEAD").trim();
    mergedGh(`echo '[{"number":5,"headRefOid":"${head}"}]'`);
    writeFileSync(
      join(repo, ".git", "hooks", "post-checkout"),
      kind === "detach"
        ? '#!/bin/sh\ngit update-ref --no-deref HEAD "$(git rev-parse HEAD)"\n'
        : "#!/bin/sh\nexit 1\n",
      { mode: 0o755 },
    );
    await box.engine(
      Effect.gen(function* () {
        yield* (yield* Registry.Registry).register({
          name: "repo",
          path: repo,
        });
        const worktrees = yield* Worktrees.Worktrees;
        const located = yield* worktrees.resolve(
          yield* worktrees.here(repo),
          {},
        );
        yield* Effect.exit(
          (yield* Landing.Landing).done(located, { force: false }),
        );
      }),
    );
    assert.equal(box.git(repo, "branch", "--list", "fox").trim() !== "", kept);
  });
});

// A gh that never answers (a proxy's auth prompt, an SSO page it can't
// show) is given up on, where a merge button behind it spun for good.
it("a gh asked with no deadline of its own is given one", async () => {
  const located = await landFixture();
  const asked = join(box.home, "gh-asked");
  box.fakeBin("gh", `touch '${asked}'; exec sleep 600`);
  const failed = await box.engine(
    Effect.gen(function* () {
      const landing = yield* Landing.Landing;
      // `sm pr`'s lookup, which sets no deadline of its own.
      const waiting = yield* Effect.forkChild(
        Effect.flip(landing.pullRequest(located)),
      );
      while (!existsSync(asked)) {
        yield* Effect.promise(
          () => new Promise((done) => setTimeout(done, 20)),
        );
      }
      yield* TestClock.adjust("2 minutes");
      return yield* Fiber.join(waiting);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  assert.ok(failed instanceof GitHub.GitHubCliError);
  assert.equal(failed.reason, "timeout");
});
