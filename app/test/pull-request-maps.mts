// Durable proof of the project's pull request map (PullRequestMaps,
// host/lib/githubCli/PullRequestMaps.ts), the sidebar's dots: any read
// that moves the map moves its view, the create dialog's stack lookup
// past the map's age among them, where only the sweep's read told the
// view before. A failed read isn't kept as an answer: the last good map
// stays, and the next ask reads again. The map ages by whichever clock
// reads older: a sleep or a forward step of the wall clock reads it
// again, and a backward step keeps it no longer than its monotonic age.
//
// Drives the real host code against a fake gh on PATH, which answers
// the project-wide list from a file, or fails while another file is
// there, and counts the lists it was asked for. The reads run on a test
// clock the proof moves. Run: pnpm test pull-request-maps.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Project, PullRequest } from "@shigomori/contracts/schemas";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, it } from "vitest";
import { githubCliViews } from "../host/ipc/modules/githubCli.ts";
import { githubCliContract } from "@shigomori/contracts/modules/githubCli";
import * as HostPushes from "../host/lib/HostPushes.ts";
import {
  type ProjectRef,
  PullRequestMaps,
} from "../host/lib/githubCli/PullRequestMaps.ts";
import { getPullRequestDraft } from "../host/lib/githubCli/newPullRequest.ts";
import { addProject } from "../host/lib/projects/index.ts";
import { initDataDirAt } from "../shared/paths.ts";
import { engineDataDir, runHost, type Services } from "./lib/hostRuntime.mts";
import {
  installFakeGh,
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  sleepingClock,
  tempDir,
  testClock,
  waitFor,
} from "./lib/checkKit.mts";

const AGE = 5 * 60_000;
const HOUR = 3_600_000;

scrubProcessGitEnv();
const tracker = makeTracker();
const root = tempDir("sm-pr-maps-", tracker.track);
const list = join(root, "list.json");
const failing = join(root, "gh-fails");
const asked = join(root, "asked");
const signedOut = join(root, "gh-signed-out");
const hold = join(root, "gh-hold");
const held = join(root, "gh-held");
const detail = join(root, "gh-detail.json");
const holdBranch = join(root, "gh-hold-branch");
const heldBranch = join(root, "gh-held-branch");
installFakeGh(
  root,
  `#!/bin/sh
case "$*" in
  "auth token"*) if [ -f '${signedOut}' ]; then exit 1; fi;;
  "pr list --state all --limit "*)
    echo >> '${asked}'
    if [ -f '${failing}' ]; then echo "connection reset" >&2; exit 1; fi
    answer=$(cat '${list}')
    if [ -f '${hold}' ]; then
      : > '${held}'
      while [ -f '${hold}' ]; do sleep 0.02; done
    fi
    echo "$answer";;
  "pr list --state all --head fox "*)
    answer=$(cat '${detail}')
    if [ -f '${holdBranch}' ]; then
      : > '${heldBranch}'
      while [ -f '${holdBranch}' ]; do sleep 0.02; done
    fi
    echo "$answer";;
  "api graphql "*) echo '{"data":{"repository":{"pullRequests":{"nodes":[]}}}}';;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`,
  tracker.track,
);
const ghHost = process.env["GH_HOST"];
delete process.env["GH_HOST"];
tracker.track(() => {
  if (ghHost !== undefined) process.env["GH_HOST"] = ghHost;
});

const git = sandboxGit();
function repoOn(name: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  return repo;
}

const pr = (number: number, state: PullRequest["state"]) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  title: `PR ${number}`,
  state,
  isDraft: false,
  headRefName: "fox",
  baseRefName: "main",
  isCrossRepository: false,
});
const answer = (rows: object[]) => writeFileSync(list, JSON.stringify(rows));
const lists = () =>
  existsSync(asked) ? readFileSync(asked, "utf8").split("\n").length - 1 : 0;

const clock = testClock();
const clocks = sleepingClock(clock);
const at = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  runHost(Effect.provideService(effect, Clock.Clock, clocks.wall));
const get = (repo: ProjectRef) =>
  at(Effect.flatMap(PullRequestMaps, (maps) => maps.get(repo)));
const refresh = (repo: ProjectRef) =>
  at(Effect.flatMap(PullRequestMaps, (maps) => maps.refresh(repo)));
const stateOf = (map: ReadonlyMap<string, PullRequest>) =>
  map.get("fox")?.state ?? null;

// A next value, or a failure once the view has said nothing for a while.
const within = <A,>(next: Effect.Effect<A>) =>
  Effect.raceFirst(
    next,
    Effect.promise(() => new Promise((r) => setTimeout(r, 3_000))).pipe(
      Effect.andThen(Effect.die(new Error("the view didn't move"))),
    ),
  );

let project: Project;
beforeAll(async () => {
  initDataDirAt(engineDataDir);
  project = await runHost(addProject(repoOn("viewed")));
});
afterAll(() => tracker.teardown());

it("a read past the map's age moves its view, the create dialog's stack lookup's too", async () => {
  answer([pr(5, "OPEN")]);
  await at(
    Effect.gen(function* () {
      const values = yield* Stream.toQueue(
        githubCliViews.watchProjectPullRequests({ projectId: project.id }),
        { capacity: "unbounded" },
      );
      const next = Queue.take(values).pipe(Effect.orDie);
      assert.equal((yield* next)["fox"]?.state, "OPEN");

      answer([pr(5, "MERGED")]);
      yield* Effect.promise(() => clock.advance(AGE + 1_000));
      const draft = yield* getPullRequestDraft({
        cwd: project.path,
        project,
        branch: "main",
        primaryRef: undefined,
      });
      assert.equal(draft.suggestedBase, null);
      assert.equal((yield* within(next))["fox"]?.state, "MERGED");
    }).pipe(Effect.scoped),
  );
});

it("a failed read isn't kept: the next ask reads again, and a failure keeps the last good map", async () => {
  const repo = { id: "failing", path: repoOn("failing") };
  writeFileSync(failing, "");
  assert.equal(stateOf(await get(repo)), null);
  rmSync(failing);
  answer([pr(5, "OPEN")]);
  assert.equal(stateOf(await get(repo)), "OPEN", "the next ask, at once");

  writeFileSync(failing, "");
  assert.equal(stateOf(await refresh(repo)), "OPEN");
  await clock.advance(AGE + 1_000);
  const before = lists();
  assert.equal(stateOf(await get(repo)), "OPEN");
  assert.equal(lists(), before + 1, "past its age, asked again");
  rmSync(failing);
  answer([pr(5, "MERGED")]);
  assert.equal(
    stateOf(await get(repo)),
    "MERGED",
    "the failure left it to be read again",
  );
});

it("the map ages by whichever clock reads older: a sleep, a stopped process or the wall clock stepped forward reads it again, and a backward step keeps it no longer", async () => {
  const repo = { id: "stepped", path: repoOn("stepped") };
  answer([pr(5, "OPEN")]);
  await get(repo);
  let read = lists();
  for (const [what, move] of [
    ["a sleep past its age", () => clocks.sleep(AGE + 1_000)],
    ["a stopped process past its age", () => clocks.stop(AGE + 1_000)],
    ["the wall clock two hours on", () => clocks.sleep(2 * HOUR)],
  ] as const) {
    move();
    await get(repo);
    read += 1;
    assert.equal(lists(), read, `${what}: read again`);
  }

  clocks.sleep(-4 * HOUR);
  await clock.advance(AGE - 1_000);
  await get(repo);
  assert.equal(lists(), read, "back four hours, inside its age: fresh");
  await clock.advance(2_000);
  await get(repo);
  assert.equal(lists(), read + 1, "past its age: read again");
  // The wall clock where it was, so no wall-clock TTL stamped before
  // the step (the readiness probe's) outlives it.
  clocks.sleep(4 * HOUR);
});

it("a good read after the gate answered empty moves the view, though it equals the stored map", async () => {
  const gatedProject = await runHost(addProject(repoOn("gated")));
  answer([pr(5, "OPEN")]);
  await at(
    Effect.gen(function* () {
      const values = yield* Stream.toQueue(
        githubCliViews.watchProjectPullRequests({
          projectId: gatedProject.id,
        }),
        { capacity: "unbounded" },
      );
      const next = Queue.take(values).pipe(Effect.orDie);
      assert.equal((yield* next)["fox"]?.state, "OPEN");

      // gh's token gone, past the readiness probe's 30 s, and the view
      // read again meanwhile.
      writeFileSync(signedOut, "");
      yield* Effect.promise(() => clock.advance(31_000));
      yield* HostPushes.push(
        githubCliContract,
        "projectPullRequestsRefreshed",
        {
          projectId: gatedProject.id,
        },
      );
      assert.deepEqual(yield* within(next), {});

      rmSync(signedOut);
      yield* Effect.promise(() => clock.advance(31_000));
      yield* Effect.flatMap(PullRequestMaps, (maps) =>
        maps.refresh(gatedProject),
      );
      assert.equal((yield* within(next))["fox"]?.state, "OPEN");
    }).pipe(Effect.scoped),
  );
});

const detailOf = (state: PullRequest["state"]) => ({
  ...pr(5, state),
  body: "",
  mergeStateStatus: "CLEAN",
  autoMergeRequest: null,
  author: { login: "me" },
  updatedAt: "2026-10-01T00:00:00Z",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  statusCheckRollup: [],
});

// A list gh answered with `rows`, held until `release`.
const heldList = async (repo: ProjectRef, rows: object[]) => {
  answer(rows);
  rmSync(held, { force: true });
  writeFileSync(hold, "");
  const pending = refresh(repo);
  await waitFor(() => existsSync(held), "the held list to start");
  return () => {
    rmSync(hold);
    return pending;
  };
};

it("a list that started before a merge or a page's note doesn't land over them", async () => {
  const repo = { id: "held", path: repoOn("held") };
  answer([pr(5, "OPEN")]);
  await get(repo);

  const release = await heldList(repo, [pr(5, "OPEN")]);
  answer([pr(5, "MERGED")]);
  await at(Effect.flatMap(PullRequestMaps, (maps) => maps.moved(repo)));
  await release();
  assert.equal(
    stateOf(await get(repo)),
    "MERGED",
    "the merge's map, read after it",
  );

  const releaseAgain = await heldList(repo, [pr(5, "OPEN")]);
  writeFileSync(detail, JSON.stringify([detailOf("CLOSED")]));
  await at(
    Effect.flatMap(PullRequestMaps, (maps) =>
      maps.branchPullRequest(repo, "fox"),
    ),
  );
  await releaseAgain();
  assert.equal(stateOf(await get(repo)), "CLOSED", "the page's note kept");
});

it("a page's read that started before a merge doesn't note over it", async () => {
  const repo = { id: "branch-held", path: repoOn("branch-held") };
  answer([pr(5, "OPEN")]);
  await get(repo);

  writeFileSync(detail, JSON.stringify([detailOf("OPEN")]));
  rmSync(heldBranch, { force: true });
  writeFileSync(holdBranch, "");
  const pending = at(
    Effect.flatMap(PullRequestMaps, (maps) =>
      maps.branchPullRequest(repo, "fox"),
    ),
  );
  await waitFor(() => existsSync(heldBranch), "the held branch read to start");
  answer([pr(5, "MERGED")]);
  await at(Effect.flatMap(PullRequestMaps, (maps) => maps.moved(repo)));
  assert.equal(stateOf(await get(repo)), "MERGED");
  rmSync(holdBranch);
  assert.equal((await pending)?.state, "OPEN");
  assert.equal(stateOf(await get(repo)), "MERGED", "the merge kept");
});
