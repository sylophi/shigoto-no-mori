// Durable proof of the project's pull request map (PullRequestMaps,
// host/lib/githubCli/PullRequestMaps.ts), the sidebar's dots: any read
// that moves the map moves its view, the create dialog's stack lookup
// past the map's age among them, where only the sweep's read told the
// view before. A failed read isn't kept as an answer: the last good map
// stays, and the next ask reads again. The map's age is monotonic time,
// so a step of the wall clock either way neither keeps it nor drops it.
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
} from "./lib/checkKit.mts";

const AGE = 5 * 60_000;
const HOUR = 3_600_000;

scrubProcessGitEnv();
const tracker = makeTracker();
const root = tempDir("sm-pr-maps-", tracker.track);
const list = join(root, "list.json");
const failing = join(root, "gh-fails");
const asked = join(root, "asked");
installFakeGh(
  root,
  `#!/bin/sh
case "$*" in
  "auth token"*) ;;
  "pr list --state all --limit "*)
    echo >> '${asked}'
    if [ -f '${failing}' ]; then echo "connection reset" >&2; exit 1; fi
    cat '${list}';;
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

it("the map's age is monotonic: a step of the wall clock neither keeps it nor drops it", async () => {
  const repo = { id: "stepped", path: repoOn("stepped") };
  answer([pr(5, "OPEN")]);
  await get(repo);
  const read = lists();

  clocks.sleep(2 * HOUR);
  await get(repo);
  assert.equal(lists(), read, "the wall clock two hours on: still fresh");

  clocks.sleep(-4 * HOUR);
  await clock.advance(AGE - 1_000);
  await get(repo);
  assert.equal(lists(), read, "back two hours, inside its age: fresh");
  await clock.advance(2_000);
  await get(repo);
  assert.equal(lists(), read + 1, "past its age: read again");
});
