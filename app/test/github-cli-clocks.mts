// Durable proof that what gh's integration keeps in the host's memory
// (host/lib/githubCli/GithubCli.ts, through host/lib/util/kept.ts) is
// kept for its time on both clocks: read again after a sleep or a
// forward step of the wall clock, and never pinned by a backward one;
// and that a failed read is not kept: gh's hosts.yml unreadable for a
// moment, or a gh that answered nothing.
//
// Run: pnpm test github-cli-clocks.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { it } from "vitest";
import * as GithubCli from "@host/lib/githubCli/GithubCli";
import { serviceBuiltNow } from "./lib/hostRuntime.mts";
import {
  installFakeGh,
  sleepingClock,
  tempDir,
  testClock,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

const GHE = "ghe.example.test";
const GHE_REPO = `https://${GHE}/owner/repo`;
const HOUR = 3_600_000;

// gh signed in while `signedIn` is there, and asked nothing else.
function fakeGh(root: string, signedIn: string) {
  installFakeGh(
    root,
    `#!/bin/sh
case "$*" in
"auth token"*) [ -f '${signedIn}' ] && echo token || exit 1 ;;
*) exit 1 ;;
esac
`,
    trackTest,
  );
  const config = join(root, "gh-config");
  mkdirSync(config);
  return join(config, "hosts.yml");
}

const loggedInTo = (hostsFile: string, host: string | null) =>
  writeFileSync(
    hostsFile,
    host === null ? "" : `${host}:\n    user: someone\n`,
  );

// The service built over this test's gh, its calls run on `clock`.
async function cliOn(clock?: Clock.Clock) {
  const cli = await serviceBuiltNow(
    GithubCli.GithubCli,
    GithubCli.layer,
    trackTest,
  );
  const on = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(
      clock === undefined
        ? effect
        : Effect.provideService(effect, Clock.Clock, clock),
    );
  return {
    hostOf: (url: string) => on(cli.hostOf(url)),
    authed: () => on(cli.readiness).then(({ authed }) => authed),
  };
}

it("known hosts are kept their hour on both clocks: read again after a sleep, and a backward step pins nothing", async () => {
  const root = tempDir("sm-gh-clocks-", trackTest);
  const hostsFile = fakeGh(root, join(root, "signed-in"));
  const clock = testClock();
  const { wall, sleep, stop } = sleepingClock(clock);
  loggedInTo(hostsFile, GHE);
  const cli = await cliOn(wall);
  assert.equal(await cli.hostOf(GHE_REPO), GHE);
  loggedInTo(hostsFile, null);
  assert.equal(await cli.hostOf(GHE_REPO), GHE, "kept within its hour");
  // A sleep of an hour: the wall clock ran on, monotonic time stood.
  sleep(HOUR);
  assert.equal(await cli.hostOf(GHE_REPO), null, "read again after a sleep");
  // The wall clock stepped back two hours, then an hour passed awake.
  loggedInTo(hostsFile, GHE);
  sleep(-2 * HOUR);
  await clock.advance(HOUR);
  assert.equal(
    await cli.hostOf(GHE_REPO),
    GHE,
    "a backward step kept the hosts past their hour",
  );
  // Stopped for an hour: both clocks ran on.
  loggedInTo(hostsFile, null);
  stop(HOUR);
  assert.equal(await cli.hostOf(GHE_REPO), null);
});

it("readiness is kept its 30 s on both clocks: read again after a sleep, and a backward step pins nothing", async () => {
  const root = tempDir("sm-gh-clocks-", trackTest);
  const signedIn = join(root, "signed-in");
  fakeGh(root, signedIn);
  const clock = testClock();
  const { wall, sleep } = sleepingClock(clock);
  writeFileSync(signedIn, "");
  const cli = await cliOn(wall);
  assert.equal(await cli.authed(), true);
  rmSync(signedIn);
  assert.equal(await cli.authed(), true, "kept within its 30 s");
  sleep(30_000);
  assert.equal(await cli.authed(), false, "read again after a sleep");
  writeFileSync(signedIn, "");
  sleep(-HOUR);
  await clock.advance(30_000);
  assert.equal(
    await cli.authed(),
    true,
    "a backward step kept signed out past its 30 s",
  );
});

it("a hosts.yml that could not be read is read again at the next ask, not taken for github.com alone for an hour", async () => {
  const root = tempDir("sm-gh-clocks-", trackTest);
  const hostsFile = fakeGh(root, join(root, "signed-in"));
  // A directory where the file goes: the read fails.
  mkdirSync(hostsFile);
  const cli = await cliOn();
  assert.equal(await cli.hostOf(GHE_REPO), null);
  assert.equal(await cli.hostOf("https://github.com/owner/repo"), "github.com");
  rmSync(hostsFile, { recursive: true });
  loggedInTo(hostsFile, GHE);
  assert.equal(await cli.hostOf(GHE_REPO), GHE);
});

it("a gh that answered nothing reads as signed out, is not spawned again by every ask, and is asked again 10 s on", async () => {
  const root = tempDir("sm-gh-clocks-", trackTest);
  const answers = join(root, "answers");
  const spawned = join(root, "spawned");
  installFakeGh(
    root,
    `#!/bin/sh
echo >> '${spawned}'
[ -f '${answers}' ] || kill -9 $$
case "$*" in
"auth token"*) echo token ;;
*) exit 1 ;;
esac
`,
    trackTest,
  );
  const spawns = () => readFileSync(spawned, "utf8").split("\n").length - 1;
  const clock = testClock();
  const { wall, sleep } = sleepingClock(clock);
  const cli = await cliOn(wall);
  assert.equal(await cli.authed(), false);
  const once = spawns();
  writeFileSync(answers, "");
  assert.equal(await cli.authed(), false);
  assert.equal(spawns(), once, "an ask spawned the unanswered gh again");
  sleep(10_000);
  assert.equal(await cli.authed(), true, "the failed probe was kept");
});

it("an empty GH_CONFIG_DIR reads as unset, not as the working folder", async () => {
  const root = tempDir("sm-gh-clocks-", trackTest);
  installFakeGh(root, "#!/bin/sh\nexit 1\n", trackTest);
  loggedInTo(join(root, "hosts.yml"), GHE);
  process.env["GH_CONFIG_DIR"] = "";
  const cwd = process.cwd();
  process.chdir(root);
  trackTest(() => process.chdir(cwd));
  const cli = await cliOn();
  assert.equal(await cli.hostOf(GHE_REPO), null);
});
