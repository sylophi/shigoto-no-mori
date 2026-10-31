// land's removal guard: the branch goes with the land, so commits the
// PR's head never had (made after its last push, or under a name an
// older PR merged with) are refused, named, before anything is merged or
// removed, and again after a merge GitHub answered at once. Also done's
// delete of a branch, refused unless a merged PR holds it whole. Against
// real git and a scripted gh.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, it } from "vitest";
import * as Landing from "../src/Landing.ts";
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

// A gh for a one-PR land on a repo that allows auto-merge: the fox
// branch's PR #5, blocked on its checks. Each read of the PR's progress
// takes the next of `polls`, the last one answering every read after
// it. `onMerge` runs as gh merges. Every merge is logged.
function fakeGh(
  polls: ReadonlyArray<string>,
  options: { readonly onMerge?: string } = {},
) {
  const log = join(box.home, "gh.log");
  const pollFile = join(box.home, "polls");
  writeFileSync(pollFile, `${polls.join("\n")}\n`);
  box.fakeBin(
    "gh",
    `echo "$*" >> '${log}'
case "$*" in
  "pr list --state all --head fox --limit 10 --json "*) echo '[{"number":5,"title":"Fox","state":"OPEN","isDraft":false,"url":"u5","baseRefName":"main","headRefName":"fox","mergeStateStatus":"BLOCKED","autoMergeRequest":null}]';;
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

  // On the primary checkout, where done's checkout of main frees the
  // branch for its `branch -D`: a linked worktree can't check main out.
  it("done refuses a branch its merged PR doesn't hold whole, and one GitHub couldn't be asked about", async () => {
    const upstream = box.repo("upstream", { "README.md": "hi\n" });
    const repo = join(box.home, "repo");
    execFileSync("git", ["clone", "-q", upstream, repo]);
    box.git(repo, "checkout", "-q", "-b", "fox");
    box.git(repo, "commit", "-q", "--allow-empty", "-m", "fox");
    const head = box.git(repo, "rev-parse", "HEAD").trim();
    box.git(repo, "commit", "-q", "--allow-empty", "-m", "late");
    const located = (await box.engine(
      Effect.gen(function* () {
        yield* (yield* Registry.Registry).register({
          name: "repo",
          path: repo,
        });
        const worktrees = yield* Worktrees.Worktrees;
        return yield* worktrees.resolve(yield* worktrees.here(repo), {});
      }),
    )) as Worktrees.Located;
    const kept = () => {
      assert.equal(box.git(repo, "branch", "--show-current").trim(), "fox");
      assert.match(box.git(repo, "log", "-1", "--format=%s", "fox"), /^late/);
    };

    mergedGh(`echo '[{"number":5,"headRefOid":"${head}"}]'`);
    const unpushed = await done(located);
    assert.equal(
      unpushed["code"],
      "unpushed-commits",
      JSON.stringify(unpushed),
    );
    kept();

    mergedGh(`echo 'error connecting to api.github.com' >&2; exit 1`);
    const unasked = await done(located);
    assert.equal(unasked["ok"], false, JSON.stringify(unasked));
    kept();
  });
});
