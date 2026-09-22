// The remote flows, end to end, on one machine:
//
//   pnpm test e2e/remote-smoke [--keep] [--only=<label part>,...]
//
// Two dev profiles (scripts/lib/devProfile.mts) as two devices of the
// owner's dev account, both signed in by cloning the plain dev
// instance's sign-in, driven over CDP (cdp.mts) through the real
// device hub, direct plane, dev CLI and file-sync engine.
// MANUAL-TESTING.md lists the scenarios and the prerequisites.
//
// One repo is cloned into both forests: the pull matches a local
// project by repo identity (the root commit), so two seeds would not
// do, the same clone on two machines is the real shape. Both profiles
// are wiped before and after, and their devices revoked on the hub in
// the teardown, so nothing lingers on the account (`--keep` leaves
// the windows and profiles up for a look). The tunnel path is not
// covered: on one machine the LAN candidate wins.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalTree } from "../../host/lib/scripts/process.ts";
import { devProfileNameSuffix } from "../../shared/packaging/appName.mts";
import { errorMessageOf } from "../../shared/errors.ts";
import { bringIgnores } from "../../shared/mirrorIgnores.ts";
import { isCommandRefusedError } from "../../shared/ipc/socket/frames.ts";
import {
  fileEquals,
  freeLoopbackPort,
  readOrNull,
  repoRoot,
  report,
  scrubbedGitEnv,
  waitFor,
} from "../lib/checkKit.mjs";
import {
  buildDevCli,
  cloneDevLogin,
  devCliPath,
  devProfileEnv,
  devProfilePaths,
  PROFILES_DIR,
  registerProjects,
  rmTree,
  wipeDevProfile,
  type DevProfile,
} from "../../scripts/lib/devProfile.mts";
import { attachWindow, type AppWindow } from "./cdp.mts";

const keep = process.argv.includes("--keep");
// Runs only the scenarios whose label contains one of these, for a
// quick pass over one area. The boot, the connection wait and the
// teardown always run. A scenario that leans on an earlier one's result
// fails its `need` when that one was filtered out, so name both.
const only = (
  process.argv.find((arg) => arg.startsWith("--only="))?.slice(7) ?? ""
)
  .split(",")
  .map((part) => part.trim())
  .filter((part) => part !== "");

// Git against the fixture worktrees, both of which live on this
// machine: pinned identity, the inherited GIT_* scrubbed (a lefthook
// run exports GIT_DIR for the real repository).
const gitEnv = {
  ...scrubbedGitEnv(),
  GIT_AUTHOR_NAME: "E2E",
  GIT_AUTHOR_EMAIL: "e2e@example.com",
  GIT_COMMITTER_NAME: "E2E",
  GIT_COMMITTER_EMAIL: "e2e@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" });
const gitOut = (cwd: string, ...args: string[]) =>
  git(cwd, ...args)
    .toString()
    .trim();

const runDir = join(tmpdir(), `sm-e2e-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const log = (line: string) => console.log(`[e2e] ${line}`);

type Fixture = { a: DevProfile; b: DevProfile; origin: string };

// Every run of a's setup script appends the worktree it ran in here,
// outside both forests so no mirror carries it: the pull scenarios
// read it to tell a create that ran setup from one told to skip it.
const setupLog = join(runDir, "setup-runs.log");
const setupRuns = (): string[] =>
  existsSync(setupLog)
    ? readFileSync(setupLog, "utf8").split("\n").filter(Boolean)
    : [];

// a's setup script: logs the run, then builds an ignored artifact the
// way an install or a build would, so a transplant that also brings
// the source's build output has something to disagree with.
const BUILT_ON_A = "built on a\n";
const SETUP_SCRIPT = `pwd >> ${JSON.stringify(setupLog)} && mkdir -p build-out && printf 'built on a\\n' > build-out/artifact.txt`;

// Gives the profile's one project a setup script, written straight
// into its project.json the way Project Settings would.
function configureSetupScript(profile: DevProfile, command: string): void {
  const projects = join(profile.dataDir, "projects");
  const [projectId, ...rest] = readdirSync(projects);
  assert.ok(
    projectId !== undefined && rest.length === 0,
    `expected one project under ${projects}`,
  );
  const configPath = join(projects, projectId, "project.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    scripts?: Record<string, string>;
  };
  config.scripts = { ...config.scripts, setup: command };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function prepareFixture(): Fixture {
  const a = devProfilePaths("e2e-a");
  const b = devProfilePaths("e2e-b");
  wipeDevProfile(a);
  wipeDevProfile(b);
  buildDevCli();

  const origin = join(PROFILES_DIR, "e2e-origin.git");
  rmTree(origin);
  const seed = join(runDir, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "e2e shared repo\n");
  // What a real project ignores: secrets, build output, a cache. The
  // pull scenarios put files under each and watch which ones travel.
  writeFileSync(join(seed, ".gitignore"), ".env\nbuild-out/\ncache/\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "Initial");
  git(seed, "init", "--bare", "-q", "-b", "main", origin);
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");

  for (const profile of [a, b]) {
    mkdirSync(profile.repos, { recursive: true });
    mkdirSync(profile.dataDir, { recursive: true });
    git(profile.repos, "clone", "-q", origin, "shared");
    registerProjects(profile, profile.repos);
    cloneDevLogin(profile);
  }
  configureSetupScript(a, SETUP_SCRIPT);
  return { a, b, origin };
}

// Each tree in its own process group, so a kill reaches forge and
// Electron under the pnpm wrapper, not just the wrapper.
function launch(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const out = openSync(join(runDir, `${name}.log`), "a");
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.on("exit", (code, signal) => log(`${name} exited (${signal ?? code})`));
  // A spawn failure (no pnpm on PATH) must land in the failures, not
  // crash past the teardown as an unhandled event.
  child.on("error", (error) => log(`${name} failed to launch: ${error}`));
  return child;
}

const isRunning = (child: ChildProcess) =>
  child.pid !== undefined &&
  child.exitCode === null &&
  child.signalCode === null;

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (!isRunning(child)) resolve();
    else child.once("exit", () => resolve()).once("error", () => resolve());
  });

async function killTrees(
  children: ChildProcess[],
  signal: NodeJS.Signals,
): Promise<void> {
  await Promise.all(
    children.filter(isRunning).map((child) => signalTree(child.pid!, signal)),
  );
}

// The previous scenario's product, or a failure naming what is missing.
function need<T>(value: T | undefined, from: string): T {
  assert.ok(value !== undefined, `needs ${from}`);
  return value;
}

type Project = {
  id: string;
  name: string;
  path: string;
  identity?: string | null;
};
type Worktree = {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  path: string;
};
type PullResult = {
  worktree: Worktree;
  captured: boolean;
  dirtyApplied: boolean;
  files?: { crossed: boolean; conflicts: number; error?: string };
};
type MirrorList = {
  sessions: { session: string; localWorktreeId: string; ignoreMode: string }[];
  serving: { worktreeId: string }[];
};

const refusalOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => null,
    (error: unknown) => error,
  );

// What marks a control the user cannot press, the native attribute
// and Base UI's own, as a selector literal for renderer expressions.
const NOT_CLICKABLE = JSON.stringify(
  '[disabled], [aria-disabled="true"], [data-disabled]',
);

// A renderer expression for the innermost element whose text is
// exactly this, for the scenarios that drive the real dialogs.
const byText = (text: string) =>
  `[...document.querySelectorAll("*")].findLast((el) => el.textContent.trim() === ${JSON.stringify(text)})`;

const hubStatus = (w: AppWindow) =>
  w.evaluate<{
    onlineDeviceIds: string[];
    peerAppVersions: Record<string, string>;
  }>("window.api.hub.status()");

const waitConnected = (w: AppWindow, peerId: string, who: string) =>
  w.waitFor(
    `${who} to hold a direct session to its peer`,
    `window.api.hub.status().then((s) => Boolean(s.peerAppVersions[${JSON.stringify(peerId)}]))`,
    90_000,
  );

const waitDropped = (w: AppWindow, peerId: string, what: string) =>
  w.waitFor(
    what,
    `window.api.hub.status().then((s) => !s.onlineDeviceIds.includes(${JSON.stringify(peerId)}))`,
    90_000,
  );

const waitSignedIn = (w: AppWindow, who: string) =>
  w.waitFor(
    `${who} to be signed in and enrolled`,
    "window.api.account.status().then((s) => s.signedIn)",
    60_000,
  );

// The teardown's revoke from one window: every device whose name
// carries the other profile's suffix (so a re-enrolled or never-read
// peer is still found), then the window's own sign-out.
async function revokeFrom(port: number, otherSuffix: string): Promise<void> {
  const w = await attachWindow(port, 5_000);
  try {
    await w.evaluate(
      `window.api.account.listDevices().then((ds) => Promise.all(ds
        .filter((d) => d.name.endsWith(${JSON.stringify(otherSuffix)}) && d.deviceId !== window.api.deviceId)
        .map((d) => window.api.account.revokeDevice(d.deviceId))))`,
    );
    await w.evaluate("window.api.account.signOut()");
  } finally {
    w.close();
  }
}

// The shared settings, driven through the renderer's own write path
// (the local copy, then an offer to each peer) rather than the raw
// channel, so the scenario covers what the Configure page runs.
const SHARED_KEY = "e2e/sharedSetting";

const setSharedSetting = (w: AppWindow, value: string) =>
  w.evaluate(
    `import("/renderer/lib/remote/sharedSettingsSync.ts").then((m) =>
      m.writeSharedSetting(${JSON.stringify(SHARED_KEY)}, ${JSON.stringify(value)}))`,
  );

const waitSharedSetting = (w: AppWindow, value: string, what: string) =>
  waitFor(
    async () => {
      const doc = await w.evaluate<{
        entries: Record<string, { value: unknown }>;
      }>("window.api.sharedSettings.read()");
      return doc.entries[SHARED_KEY]?.value === value;
    },
    what,
    30_000,
  );

// One call on a peer through a's bridge, as the renderer's hub
// transport makes it (renderer/lib/remote/hubTransport.ts).
const onPeer = (
  w: AppWindow,
  deviceId: string,
  channel: string,
  input?: unknown,
) =>
  w.evaluate(
    `window.api.hub.invokePeer(${JSON.stringify({ deviceId, channel, input })})`,
  );

async function main(): Promise<string[]> {
  const failures: string[] = [];
  const windows: AppWindow[] = [];
  const fixture = prepareFixture();
  const [portA, portB] = await Promise.all([
    freeLoopbackPort(),
    freeLoopbackPort(),
  ]);

  const primary = launch(
    "primary",
    "pnpm",
    ["start", "--profile", fixture.a.name],
    {
      ...process.env,
      SHIGOMORI_DEBUG_PORT: String(portA),
    },
  );
  let peer: ChildProcess | null = null;
  const launchPeer = () => {
    peer = launch(
      "peer",
      "node",
      [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        join(repoRoot, "scripts", "dev-peer.mts"),
        fixture.b.name,
      ],
      { ...process.env, SHIGOMORI_DEBUG_PORT: String(portB) },
    );
  };

  const shoot = (label: string) =>
    Promise.allSettled(
      windows.map(async (w) => {
        const png = await w.screenshot();
        writeFileSync(join(runDir, `${label}-${w.port}.png`), png);
      }),
    );
  const scenario = async (label: string, fn: () => Promise<void>) => {
    if (only.length > 0 && !only.some((part) => label.includes(part))) {
      log(`skip ${label}`);
      return;
    }
    try {
      await fn();
      log(`ok   ${label}`);
    } catch (error) {
      failures.push(`${label}: ${errorMessageOf(error)}`);
      log(`FAIL ${label}: ${errorMessageOf(error)}`);
      await shoot(`fail-${label.replace(/\W+/g, "-")}`);
    }
  };

  try {
    log(`primary booting on CDP ${portA} (log: ${runDir}/primary.log)`);
    const a = await attachWindow(portA, 180_000);
    windows.push(a);
    // The peer needs only the primary's build and vite server, both
    // there once its window exists, so it boots while a enrolls.
    launchPeer();
    log(`peer booting on CDP ${portB}`);
    let b = await attachWindow(portB, 120_000);
    windows.push(b);
    await Promise.all([waitSignedIn(a, "a"), waitSignedIn(b, "b")]);
    const [idA, idB] = await Promise.all([
      a.evaluate<string>("window.api.deviceId"),
      b.evaluate<string>("window.api.deviceId"),
    ]);
    await Promise.all([waitConnected(a, idB, "a"), waitConnected(b, idA, "b")]);
    log(`connected: a=${idA} b=${idB}`);
    await shoot("connected");

    await scenario("presence", async () => {
      const [sa, sb] = await Promise.all([hubStatus(a), hubStatus(b)]);
      assert.ok(sa.onlineDeviceIds.includes(idB), "a's roster lacks b");
      assert.ok(sb.onlineDeviceIds.includes(idA), "b's roster lacks a");
      const devices = await a.evaluate<{ deviceId: string; online: boolean }[]>(
        "window.api.account.listDevices()",
      );
      const row = devices.find((d) => d.deviceId === idB);
      assert.ok(
        row?.online === true,
        "a's device registry does not show b online",
      );
    });

    let bProject: Project | undefined;
    await scenario("remote read", async () => {
      const projects = (await onPeer(a, idB, "projects:list")) as Project[];
      bProject = projects.find((p) => p.name === "shared");
      assert.ok(bProject !== undefined, "b's project list has no 'shared'");
      assert.ok(bProject.identity, "b's 'shared' has no identity yet");
      const worktrees = (await onPeer(a, idB, "worktrees:list", {
        projectId: bProject.id,
      })) as Worktree[];
      assert.ok(
        worktrees.some((w) => w.branch === "main"),
        "b's 'shared' has no main worktree",
      );
    });

    // No server holds the shared settings, so this is the whole
    // path: a pick made on one device has to land in the other's own
    // copy. First with b refusing commands, which leaves only the pull
    // (b's window hears a's copy move and folds it into its own), then
    // the other way round with the switch back on.
    await scenario("shared settings", async () => {
      await b.evaluate("window.api.account.setAcceptsCommands(false)");
      await setSharedSetting(a, "picked-on-a");
      await waitSharedSetting(b, "picked-on-a", "b to pull a's");
      await b.evaluate("window.api.account.setAcceptsCommands(true)");
      await setSharedSetting(b, "picked-on-b");
      await waitSharedSetting(a, "picked-on-b", "a to take b's");
      const [docA, docB] = await Promise.all([
        a.evaluate<unknown>("window.api.sharedSettings.read()"),
        b.evaluate<unknown>("window.api.sharedSettings.read()"),
      ]);
      assert.deepEqual(docA, docB, "the two copies differ after the exchange");
    });

    let created: Worktree | undefined;
    await scenario("grant gate", async () => {
      const project = need(bProject, "the remote read");
      const create = () =>
        onPeer(a, idB, "worktrees:create", {
          projectId: project.id,
          branchName: "feat/e2e",
        }) as Promise<{ worktree: Worktree }>;
      await b.evaluate("window.api.account.setAcceptsCommands(false)");
      const refused = await refusalOf(create());
      assert.ok(refused !== null, "create was served with commands off");
      assert.ok(
        isCommandRefusedError(refused),
        `unexpected refusal: ${errorMessageOf(refused)}`,
      );
      await b.evaluate("window.api.account.setAcceptsCommands(true)");
      created = (await create()).worktree;
      assert.ok(
        existsSync(created.path),
        `created worktree missing on disk: ${created.path}`,
      );
    });

    let pulled: Worktree | undefined;
    await scenario("pull", async () => {
      const project = need(bProject, "the remote read");
      const source = need(created, "the grant gate");
      const result = await a.evaluate<{ worktree: Worktree }>(
        `window.api.sync.pullWorktree(${JSON.stringify({
          sourceDeviceId: idB,
          sourceProjectId: project.id,
          sourceWorktreeId: source.id,
          sourceIdentity: project.identity,
          branch: source.branch,
        })})`,
      );
      pulled = result.worktree;
      assert.ok(
        pulled.path.startsWith(fixture.a.dataDir),
        `pulled worktree not under a's root: ${pulled.path}`,
      );
      assert.ok(existsSync(pulled.path), "pulled worktree missing on disk");
      const head = execFileSync("git", [
        "-C",
        pulled.path,
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ])
        .toString()
        .trim();
      assert.equal(head, "feat/e2e", "pulled worktree is on the wrong branch");
      // runSetup absent reads as yes: the create ran a's setup script.
      assert.deepEqual(
        setupRuns(),
        [pulled.path],
        "a pull that did not opt out must run the setup script once",
      );
    });

    // Continuous mirroring, end to end through both apps' engines: a
    // mirrors a fresh worktree of b's (its own worktree, so the
    // transplant below keeps its source), files cross both ways as
    // edits happen (a gitignored-style file included), a commit on b
    // lands on a through the git follower, and stopping the session
    // clears both sides. Both worktrees sit on this machine, so the
    // disk is asserted directly.
    await scenario("mirror", async () => {
      const project = need(bProject, "the remote read");
      const source = (
        (await onPeer(a, idB, "worktrees:create", {
          projectId: project.id,
          branchName: "feat/mirror",
        })) as { worktree: Worktree }
      ).worktree;
      const started = await a.evaluate<{
        worktree: Worktree;
        session: string;
      }>(
        `window.api.mirror.start(${JSON.stringify({
          sourceDeviceId: idB,
          sourceProjectId: project.id,
          sourceWorktreeId: source.id,
          sourceIdentity: project.identity,
          branch: source.branch,
          runSetup: false,
          ignoreMode: "everything",
          ignores: [],
        })})`,
      );
      const local = started.worktree;
      assert.ok(
        !setupRuns().includes(local.path),
        "a mirror started with runSetup false still ran the setup script",
      );
      assert.ok(
        local.path.startsWith(fixture.a.dataDir),
        `mirrored worktree not under a's root: ${local.path}`,
      );
      const session = JSON.stringify(started.session);
      await a.waitFor(
        "a's mirror session to be watching with git in sync",
        `window.api.mirror.list().then((m) => m.sessions.some((s) => s.session === ${session} && s.status === "watching" && s.git?.status === "synced"))`,
        90_000,
      );
      await b.waitFor(
        "b to list the stream it serves",
        `window.api.mirror.list().then((m) => m.serving.some((s) => s.worktreeId === ${JSON.stringify(source.id)}))`,
        30_000,
      );
      // The session says which rule it runs under and when it began,
      // b's served stream names a's copy, and the thread has its start.
      const listed = await a.evaluate<{
        sessions: {
          session: string;
          ignoreMode: string;
          ignores: string[];
          createdAt: number;
        }[];
      }>("window.api.mirror.list()");
      const own = listed.sessions.find((s) => s.session === started.session);
      assert.ok(own, "a's session is not listed");
      assert.equal(own.ignoreMode, "everything");
      assert.deepEqual(own.ignores, []);
      assert.ok(own.createdAt > 0, "the session has no creation time");
      const servedOnB = await b.evaluate<{
        serving: { worktreeId: string; peerWorktreeId?: string }[];
      }>("window.api.mirror.list()");
      assert.equal(
        servedOnB.serving.find((s) => s.worktreeId === source.id)
          ?.peerWorktreeId,
        local.id,
        "b's served stream does not name a's copy",
      );
      const history = await a.evaluate<{ events: { kind: string }[] }>(
        `window.api.mirror.history(${JSON.stringify({ localWorktreeId: local.id })})`,
      );
      assert.equal(history.events[0]?.kind, "started");
      // Files, both ways, including one git ignores.
      writeFileSync(join(source.path, "from-b.txt"), "written on b\n");
      await waitFor(
        () => fileEquals(join(local.path, "from-b.txt"), "written on b\n"),
        "b's file to reach a",
        30_000,
      );
      writeFileSync(join(local.path, ".env"), "SECRET=1\n");
      await waitFor(
        () => fileEquals(join(source.path, ".env"), "SECRET=1\n"),
        "a's ignored file to reach b",
        30_000,
      );
      // A commit on b lands on a: same tip, same branch, clean status.
      git(source.path, "add", "from-b.txt");
      git(source.path, "commit", "-q", "-m", "on b");
      const tip = gitOut(source.path, "rev-parse", "HEAD");
      await waitFor(
        () => gitOut(local.path, "rev-parse", "HEAD") === tip,
        "a's tip to follow b's commit",
        60_000,
      );
      assert.equal(
        gitOut(local.path, "symbolic-ref", "HEAD"),
        "refs/heads/feat/mirror",
      );
      await waitFor(
        () =>
          gitOut(
            local.path,
            "status",
            "--porcelain",
            "--untracked-files=no",
          ) === "",
        "a's worktree to read clean after the follow",
        30_000,
      );
      // A change of ignores re-opens the session on the same pair: a
      // path under the new rule stays on a while its sibling crosses.
      const reopened = await a.evaluate<{ session: string }>(
        `window.api.mirror.setIgnores(${JSON.stringify({
          session: started.session,
          ignoreMode: "custom",
          ignores: ["/private-notes"],
        })})`,
      );
      assert.notEqual(reopened.session, started.session);
      const session2 = JSON.stringify(reopened.session);
      await a.waitFor(
        "the re-opened session to be watching",
        `window.api.mirror.list().then((m) => m.sessions.some((s) => s.session === ${session2} && s.status === "watching" && s.ignoreMode === "custom"))`,
        90_000,
      );
      mkdirSync(join(local.path, "private-notes"), { recursive: true });
      writeFileSync(join(local.path, "private-notes", "todo.md"), "mine\n");
      writeFileSync(join(local.path, "shared-note.md"), "everyone\n");
      await waitFor(
        () => fileEquals(join(source.path, "shared-note.md"), "everyone\n"),
        "a's file beside the ignored folder to reach b",
        30_000,
      );
      assert.ok(
        !existsSync(join(source.path, "private-notes", "todo.md")),
        "a path under the mirror's ignores crossed to b",
      );
      // Stop: the session leaves a's list, the stream leaves b's, and
      // a's copy goes with the session. The source stays. Forced,
      // because the host refuses an unforced stop unless the git
      // follower has reported "synced", and a session this young may
      // not have reconciled yet: this check is about the teardown, not
      // about the confirmation rule (host/ipc/modules/mirror.ts).
      await a.evaluate(`window.api.mirror.stop(${session2}, true)`);
      await a.waitFor(
        "a's mirror session to be gone",
        `window.api.mirror.list().then((m) => !m.sessions.some((s) => s.session === ${session2}))`,
        30_000,
      );
      await b.waitFor(
        "b's served stream to be gone",
        `window.api.mirror.list().then((m) => !m.serving.some((s) => s.worktreeId === ${JSON.stringify(source.id)}))`,
        30_000,
      );
      await a.waitFor(
        "a's copy to be removed with the stop",
        `window.api.worktrees.list(${JSON.stringify(local.projectId)}).then((list) => !list.some((w) => w.id === ${JSON.stringify(local.id)}))`,
        30_000,
      );
      assert.ok(
        !existsSync(local.path),
        "the mirrored worktree stayed on disk after stop",
      );
      assert.ok(
        existsSync(source.path),
        "the source worktree vanished on stop",
      );
    });

    await scenario("transplant", async () => {
      const project = need(bProject, "the remote read");
      const source = need(created, "the grant gate");
      const local = need(pulled, "the pull");
      const result = await a.evaluate<{
        sourceRemoved: boolean;
        sourceError?: string;
      }>(
        `window.api.sync.teardownSource(${JSON.stringify({
          sourceDeviceId: idB,
          sourceProjectId: project.id,
          sourceWorktreeId: source.id,
        })})`,
      );
      assert.ok(result.sourceRemoved, `source kept: ${result.sourceError}`);
      assert.ok(!existsSync(source.path), "source worktree still on disk");
      assert.ok(existsSync(local.path), "pulled worktree vanished");
    });

    // ---- The two pull flows' edge cases, as their dialogs drive them:
    // the leave-out rule, the setup switch, and what each refuses.
    // Every source is a fresh worktree of b's under a pinned folder
    // name, which the pull carries over like the dialogs do.
    const sourceOnB = async (
      label: string,
      prepare: (path: string) => void = () => {},
    ): Promise<Worktree> => {
      const project = need(bProject, "the remote read");
      const { worktree } = (await onPeer(a, idB, "worktrees:create", {
        projectId: project.id,
        branchName: `edge/${label}`,
        worktreeName: `src-${label}`,
      })) as { worktree: Worktree };
      // What a lived-in worktree holds that git never carries.
      writeFileSync(join(worktree.path, ".env"), "SECRET=b\n");
      mkdirSync(join(worktree.path, "build-out"), { recursive: true });
      writeFileSync(
        join(worktree.path, "build-out", "artifact.txt"),
        "built on b\n",
      );
      mkdirSync(join(worktree.path, "cache"), { recursive: true });
      writeFileSync(join(worktree.path, "cache", "blob.txt"), "cached on b\n");
      prepare(worktree.path);
      return worktree;
    };
    const pullInput = (source: Worktree, extra: Record<string, unknown>) => {
      const project = need(bProject, "the remote read");
      return JSON.stringify({
        sourceDeviceId: idB,
        sourceProjectId: project.id,
        sourceWorktreeId: source.id,
        sourceIdentity: project.identity,
        branch: source.branch,
        worktreeName: source.name,
        ...extra,
      });
    };
    const pullHere = (source: Worktree, extra: Record<string, unknown>) =>
      a.evaluate<PullResult>(
        `window.api.sync.pullWorktree(${pullInput(source, extra)})`,
      );
    const mirrorHere = (source: Worktree, extra: Record<string, unknown>) =>
      a.evaluate<PullResult & { session: string }>(
        `window.api.mirror.start(${pullInput(source, extra)})`,
      );
    const teardown = (source: Worktree) =>
      a.evaluate<{ sourceRemoved: boolean; sourceError?: string }>(
        `window.api.sync.teardownSource(${JSON.stringify({
          sourceDeviceId: idB,
          sourceProjectId: need(bProject, "the remote read").id,
          sourceWorktreeId: source.id,
        })})`,
      );
    const mirrorOp = (op: "pause" | "resume" | "stop", session: string) =>
      a.evaluate(`window.api.mirror.${op}(${JSON.stringify(session)})`);
    const mirrorsOn = (w: AppWindow) =>
      w.evaluate<MirrorList>("window.api.mirror.list()");
    const waitMirror = (session: string, what: string, test: string) =>
      a.waitFor(
        what,
        `window.api.mirror.list().then((m) => m.sessions.some((s) => s.session === ${JSON.stringify(session)} && (${test})))`,
        90_000,
      );
    // a's own copy of the shared project, the one every pull lands in.
    const ownProjectOnA = async (): Promise<Project> =>
      need(
        (await a.evaluate<Project[]>("window.api.projects.list()")).find(
          (p) => p.name === "shared",
        ),
        "a's own project",
      );
    const aRepo = join(fixture.a.repos, "shared");
    const incomingRefs = () =>
      gitOut(aRepo, "for-each-ref", "refs/shigomori/incoming");

    // The default the dialogs pick when nothing is left out: no setup,
    // because what setup would build comes over with everything else.
    // The uncommitted work and every ignored file land as the source
    // had them, one way, and the transfer leaves no session behind.
    await scenario("transplant: setup off, nothing left out", async () => {
      const source = await sourceOnB("all", (path) => {
        writeFileSync(join(path, "README.md"), "edited on b\n");
        writeFileSync(join(path, "notes.txt"), "untracked on b\n");
      });
      const result = await pullHere(source, {
        runSetup: false,
        ignoreMode: "everything",
        ignores: [],
      });
      const local = result.worktree;
      assert.equal(local.name, source.name, "the copy lost the folder name");
      assert.ok(
        !setupRuns().includes(local.path),
        "the setup script ran with the switch off",
      );
      assert.ok(result.captured && result.dirtyApplied, "the edits were lost");
      assert.equal(readOrNull(join(local.path, "README.md")), "edited on b\n");
      assert.equal(
        readOrNull(join(local.path, "notes.txt")),
        "untracked on b\n",
      );
      assert.deepEqual(result.files, { crossed: true, conflicts: 0 });
      assert.equal(readOrNull(join(local.path, ".env")), "SECRET=b\n");
      assert.equal(
        readOrNull(join(local.path, "build-out", "artifact.txt")),
        "built on b\n",
        "with setup off the source's build output is the copy's",
      );
      assert.equal(
        readOrNull(join(local.path, "cache", "blob.txt")),
        "cached on b\n",
      );
      // One way, once. The transfer never shows as a mirror on a (its
      // list hides transfers by their label), so that it ENDED is read
      // off b, which serves the stream only while a's session lives.
      // Nothing written here afterwards reaches b.
      writeFileSync(join(local.path, "cache", "later.txt"), "after\n");
      assert.deepEqual(
        (await mirrorsOn(a)).sessions,
        [],
        "the transplant left something a's mirror surfaces would show",
      );
      await b.waitFor(
        "b to stop serving the transfer, which ends with a's session",
        `window.api.mirror.list().then((m) => !m.serving.some((s) => s.worktreeId === ${JSON.stringify(source.id)}))`,
        30_000,
      );
      assert.ok(
        !existsSync(join(source.path, "cache", "later.txt")),
        "a file written on a after the transplant reached b",
      );
      // The finish step: the source goes, forced because its edits
      // were captured and applied, and the copy stays whole.
      const torn = await teardown(source);
      assert.ok(torn.sourceRemoved, `source kept: ${torn.sourceError}`);
      assert.ok(!existsSync(source.path), "the source is still on disk");
      assert.equal(readOrNull(join(local.path, ".env")), "SECRET=b\n");
      assert.equal(incomingRefs(), "", "an incoming ref survived the pull");
    });

    // Setup on with nothing left out is the pairing the default avoids:
    // both sides then hold build output. The copy keeps what its own
    // setup built, the clash is counted, and the rest still crosses.
    await scenario(
      "transplant: setup on meets the source's build",
      async () => {
        const source = await sourceOnB("clash");
        const result = await pullHere(source, {
          runSetup: true,
          ignoreMode: "everything",
          ignores: [],
        });
        const local = result.worktree;
        assert.ok(
          setupRuns().includes(local.path),
          "the setup script never ran",
        );
        assert.equal(result.files?.crossed, true, result.files?.error);
        assert.ok(
          (result.files?.conflicts ?? 0) >= 1,
          "the two build outputs were not reported as a clash",
        );
        assert.equal(
          readOrNull(join(local.path, "build-out", "artifact.txt")),
          BUILT_ON_A,
          "the copy lost its own build output to the source's",
        );
        assert.equal(readOrNull(join(local.path, ".env")), "SECRET=b\n");
        assert.equal(
          readOrNull(join(source.path, "build-out", "artifact.txt")),
          "built on b\n",
          "the transfer wrote into the source",
        );
      },
    );

    // A custom rule: the picked path stays on b, its siblings cross.
    // The source is left standing for the refusals below.
    let standing: { source: Worktree; local: Worktree } | undefined;
    await scenario("transplant: custom rule", async () => {
      const source = await sourceOnB("custom");
      const result = await pullHere(source, {
        runSetup: false,
        ignoreMode: "custom",
        ignores: ["/cache"],
      });
      const local = result.worktree;
      standing = { source, local };
      assert.deepEqual(result.files, { crossed: true, conflicts: 0 });
      assert.ok(
        !existsSync(join(local.path, "cache")),
        "a path the custom rule left out crossed anyway",
      );
      assert.equal(readOrNull(join(local.path, ".env")), "SECRET=b\n");
      assert.equal(
        readOrNull(join(local.path, "build-out", "artifact.txt")),
        "built on b\n",
      );
      assert.ok(!setupRuns().includes(local.path));
    });

    // Gitignored leaves every ignored file behind, so there is no files
    // step at all and setup has to build the copy's own: the switch
    // defaults on there, and an absent runSetup reads as on.
    await scenario("transplant: gitignored rule", async () => {
      const source = await sourceOnB("gitignored");
      const project = need(bProject, "the remote read");
      const ignored = (await onPeer(a, idB, "sync:ignoredPaths", {
        projectId: project.id,
        worktreeId: source.id,
      })) as { paths: string[]; patterns: string[] };
      assert.deepEqual(
        ignored.paths.toSorted(),
        [".env", "build-out/", "cache/"],
        "the review would list the wrong ignored files",
      );
      const result = await pullHere(source, {
        ignoreMode: "gitignored",
        ignores: ignored.patterns,
      });
      const local = result.worktree;
      assert.equal(result.files, undefined, "gitignored ran a files step");
      assert.ok(setupRuns().includes(local.path), "setup did not default on");
      assert.ok(
        !existsSync(join(local.path, ".env")),
        "an ignored file crossed",
      );
      assert.ok(!existsSync(join(local.path, "cache")));
      assert.equal(
        readOrNull(join(local.path, "build-out", "artifact.txt")),
        BUILT_ON_A,
      );
      // A clean source goes without force.
      const torn = await teardown(source);
      assert.ok(torn.sourceRemoved, `source kept: ${torn.sourceError}`);
    });

    // Gitignored with an exception: the picked path crosses, and the
    // rest of what git ignores stays on b.
    await scenario("transplant: bring rule", async () => {
      const source = await sourceOnB("bring");
      const project = need(bProject, "the remote read");
      const ignored = (await onPeer(a, idB, "sync:ignoredPaths", {
        projectId: project.id,
        worktreeId: source.id,
      })) as { patterns: string[] };
      const result = await pullHere(source, {
        runSetup: false,
        ignoreMode: "bring",
        ignores: bringIgnores(ignored.patterns, [".env"]),
      });
      const local = result.worktree;
      assert.deepEqual(result.files, { crossed: true, conflicts: 0 });
      assert.equal(readOrNull(join(local.path, ".env")), "SECRET=b\n");
      assert.ok(
        !existsSync(join(local.path, "cache")),
        "an ignored path the bring rule did not name crossed",
      );
      assert.ok(!existsSync(join(local.path, "build-out")));
      const torn = await teardown(source);
      assert.ok(torn.sourceRemoved, `source kept: ${torn.sourceError}`);
    });

    // A setup script that fails does not fail the transplant: the
    // worktree is real, and the uncommitted work still lands in it.
    await scenario("transplant: failing setup script", async () => {
      const source = await sourceOnB("badsetup", (path) => {
        writeFileSync(join(path, "README.md"), "edited before a bad setup\n");
      });
      const aProject = await ownProjectOnA();
      const id = JSON.stringify(aProject.id);
      const original = await a.evaluate<{ scripts?: Record<string, string> }>(
        `window.api.shigomori.read(${id})`,
      );
      const writeSetup = (setup: string) =>
        a.evaluate(
          `window.api.shigomori.write(${id}, ${JSON.stringify({
            ...original,
            scripts: { ...original.scripts, setup },
          })})`,
        );
      await writeSetup(`pwd >> ${JSON.stringify(setupLog)} && exit 7`);
      try {
        const result = await pullHere(source, { runSetup: true });
        const local = result.worktree;
        assert.ok(setupRuns().includes(local.path), "the bad setup never ran");
        assert.ok(existsSync(local.path), "the worktree did not survive");
        assert.ok(result.dirtyApplied, "the edits were lost to a bad setup");
        assert.equal(
          readOrNull(join(local.path, "README.md")),
          "edited before a bad setup\n",
        );
      } finally {
        await writeSetup(SETUP_SCRIPT);
      }
    });

    // What a pull refuses, before a byte moves and leaving nothing
    // behind: a branch this device already holds (a second transplant
    // or a mirror of the same worktree), a folder name already taken,
    // and a branch that is gone from the source. A source edited after
    // its transplant is kept by the finish step.
    await scenario("pull refusals", async () => {
      const { source, local } = need(standing, "the custom rule transplant");
      const before = await a.evaluate<Worktree[]>(
        `window.api.worktrees.list(${JSON.stringify(local.projectId)})`,
      );
      const again = await refusalOf(pullHere(source, { runSetup: false }));
      assert.match(errorMessageOf(again), /already/i, "a second pull landed");
      const mirrored = await refusalOf(
        mirrorHere(source, { ignoreMode: "everything", ignores: [] }),
      );
      assert.match(errorMessageOf(mirrored), /already/i, "a mirror landed");
      const other = await sourceOnB("taken");
      const taken = await refusalOf(
        pullHere(other, { runSetup: false, worktreeName: local.name }),
      );
      assert.match(
        errorMessageOf(taken),
        new RegExp(local.name),
        "a pull into a taken folder was not refused by name",
      );
      const gone = await refusalOf(
        pullHere({ ...other, branch: "edge/never-existed" }, {}),
      );
      assert.match(errorMessageOf(gone), /no longer exists/);
      const after = await a.evaluate<Worktree[]>(
        `window.api.worktrees.list(${JSON.stringify(local.projectId)})`,
      );
      assert.deepEqual(
        after.map((w) => w.id).toSorted(),
        before.map((w) => w.id).toSorted(),
        "a refused pull left a worktree behind",
      );
      assert.ok(
        !(await mirrorsOn(a)).sessions.some(
          (s) => s.localWorktreeId === local.id,
        ),
        "a refused mirror left a session behind",
      );
      assert.equal(incomingRefs(), "", "a refused pull left an incoming ref");
      // The source moved on after its transplant: it is kept, with why.
      writeFileSync(join(source.path, "late.txt"), "written after the pull\n");
      const torn = await teardown(source);
      assert.equal(torn.sourceRemoved, false, "an edited source was removed");
      assert.match(torn.sourceError ?? "", /uncommitted|changed/);
      assert.ok(existsSync(source.path), "the edited source is gone");
    });

    // The transplant the other way, as the local page's "Transplant
    // to" drives it: one of a's worktrees goes to b, which only has to
    // accept a's commands (a gives no grant of its own). The branch,
    // the uncommitted work and the ignored files land there, a second
    // send is refused by b, and the finish step removes a's source
    // only while it is still what was sent.
    await scenario("transplant to a peer", async () => {
      const own = await ownProjectOnA();
      const { worktree: source } = await a.evaluate<{ worktree: Worktree }>(
        `window.api.worktrees.create(${JSON.stringify({
          projectId: own.id,
          branchName: "edge/sent",
          worktreeName: "src-sent",
        })})`,
      );
      writeFileSync(join(source.path, "README.md"), "edited on a\n");
      writeFileSync(join(source.path, "notes.txt"), "untracked on a\n");
      writeFileSync(join(source.path, ".env"), "SECRET=a\n");
      const sendInput = JSON.stringify({
        targetDeviceId: idB,
        projectId: own.id,
        worktreeId: source.id,
        runSetup: false,
        ignoreMode: "everything",
        ignores: [],
      });
      const result = await a.evaluate<PullResult>(
        `window.api.sync.sendWorktree(${sendInput})`,
      );
      const landed = result.worktree;
      assert.ok(
        landed.path.startsWith(realpathSync(fixture.b.dataDir)),
        `the copy landed outside b's data dir: ${landed.path}`,
      );
      assert.equal(landed.name, source.name, "the copy lost the folder name");
      assert.equal(landed.branch, "edge/sent");
      assert.ok(result.captured && result.dirtyApplied, "the edits were lost");
      assert.equal(readOrNull(join(landed.path, "README.md")), "edited on a\n");
      assert.equal(
        readOrNull(join(landed.path, "notes.txt")),
        "untracked on a\n",
      );
      assert.deepEqual(result.files, { crossed: true, conflicts: 0 });
      assert.equal(readOrNull(join(landed.path, ".env")), "SECRET=a\n");
      assert.equal(
        gitOut(
          join(fixture.b.repos, "shared"),
          "for-each-ref",
          "refs/shigomori/incoming",
        ),
        "",
        "the send left an incoming ref on b",
      );
      await assert.rejects(
        () => a.evaluate(`window.api.sync.sendWorktree(${sendInput})`),
        /The other device answered: edge\/sent is already checked out/,
      );
      const sentRef = JSON.stringify({
        targetDeviceId: idB,
        projectId: own.id,
        worktreeId: source.id,
      });
      const tearDownSent = () =>
        a.evaluate<{ sourceRemoved: boolean; sourceError?: string }>(
          `window.api.sync.teardownSent(${sentRef})`,
        );
      writeFileSync(join(source.path, "late.txt"), "written after the send\n");
      const kept = await tearDownSent();
      assert.equal(kept.sourceRemoved, false, "an edited source was removed");
      assert.match(kept.sourceError ?? "", /changed/);
      rmSync(join(source.path, "late.txt"));
      const torn = await tearDownSent();
      assert.ok(torn.sourceRemoved, `source kept: ${torn.sourceError}`);
      assert.ok(!existsSync(source.path), "source worktree still on disk");
      assert.ok(existsSync(landed.path), "the sent worktree vanished");
    });

    // The same verbs from a terminal, the way an agent runs them: the
    // real dev CLI, pointed at a's data dir, finds a's control wire
    // through control.json and asks a's app, which runs the dialogs'
    // own orchestrators against b. Devices are named, never id'd, and
    // with b the only ready device none needs naming at all.
    await scenario("cli: send, bring and mirror", async () => {
      const own = await ownProjectOnA();
      type Doc = Record<string, unknown> & {
        ok?: boolean;
        worktree?: Worktree;
      };
      const smdDocs = (
        ...args: string[]
      ): { code: number; docs: unknown[] } => {
        let stdout = "";
        let code = 0;
        try {
          stdout = execFileSync(devCliPath(), ["--json", ...args], {
            cwd: aRepo,
            env: { ...process.env, ...devProfileEnv(fixture.a) },
            stdio: ["ignore", "pipe", "pipe"],
          }).toString();
        } catch (error) {
          const failed = error as { status?: number; stdout?: Buffer };
          code = failed.status ?? -1;
          stdout = failed.stdout?.toString() ?? "";
        }
        const docs = stdout
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as unknown);
        return { code, docs };
      };
      // A verb's final {ok} document, past its progress events.
      const smd = (...args: string[]): { code: number; doc: Doc } => {
        const { code, docs } = smdDocs(...args);
        const doc = need(
          (docs as Doc[]).findLast(
            (candidate) => typeof candidate.ok === "boolean",
          ),
          `a final document from smd ${args.join(" ")}`,
        );
        return { code, doc };
      };

      // b alone accepts commands, which is all either direction needs.
      await b.evaluate("window.api.account.setAcceptsCommands(true)");
      const listed = smd("devices").doc as Doc & {
        devices: { deviceId: string; name: string; block?: string }[];
      };
      const rowB = need(
        listed.devices.find((device) => device.deviceId === idB),
        "b in `smd devices`",
      );
      assert.equal(rowB.block, undefined, `b is not ready: ${rowB.block}`);

      // send: a's worktree, with an edit, an untracked file and an
      // ignored one, lands on b and the source is torn down.
      const { worktree: source } = await a.evaluate<{ worktree: Worktree }>(
        `window.api.worktrees.create(${JSON.stringify({
          projectId: own.id,
          branchName: "cli/sent",
          worktreeName: "cli-sent",
        })})`,
      );
      writeFileSync(join(source.path, "README.md"), "edited by the agent\n");
      writeFileSync(join(source.path, ".env"), "SECRET=agent\n");
      const sent = smd(
        "worktrees",
        "send",
        "cli-sent",
        "--no-setup",
        "--source",
        "teardown",
      );
      assert.equal(sent.code, 0, JSON.stringify(sent.doc));
      const landed = need(sent.doc.worktree, "the sent worktree");
      assert.ok(
        landed.path.startsWith(realpathSync(fixture.b.dataDir)),
        `the copy landed outside b's data dir: ${landed.path}`,
      );
      assert.equal(
        readOrNull(join(landed.path, "README.md")),
        "edited by the agent\n",
      );
      assert.equal(readOrNull(join(landed.path, ".env")), "SECRET=agent\n");
      assert.deepEqual(sent.doc.source, { fate: "teardown", done: true });
      assert.ok(!existsSync(source.path), "the torn-down source is on disk");

      // bring: it comes back by its branch, named as a person would,
      // and b's copy is torn down in turn.
      const listing = smdDocs("worktrees", "list", "--remote")
        .docs[0] as (Worktree & { device: { name: string } })[];
      assert.ok(
        listing.some(
          (entry) =>
            entry.branch === "cli/sent" && entry.device.name === rowB.name,
        ),
        "list --remote lacks the worktree just sent to b",
      );
      const brought = smd(
        "worktrees",
        "bring",
        "cli/sent",
        "--no-setup",
        "--source",
        "teardown",
      );
      assert.equal(brought.code, 0, JSON.stringify(brought.doc));
      const back = need(brought.doc.worktree, "the brought worktree");
      assert.ok(back.path.startsWith(realpathSync(fixture.a.dataDir)));
      assert.equal(
        readOrNull(join(back.path, "README.md")),
        "edited by the agent\n",
      );
      assert.equal(readOrNull(join(back.path, ".env")), "SECRET=agent\n");
      assert.ok(!existsSync(landed.path), "b's torn-down copy is on disk");

      // mirror: the worktree stays here and b gets a live copy. A
      // second ask answers with the running mirror.
      const mirrored = smd("worktrees", "mirror", "cli-sent", "--no-setup");
      assert.equal(mirrored.code, 0, JSON.stringify(mirrored.doc));
      const copy = need(mirrored.doc.worktree, "the mirror's copy");
      const session = mirrored.doc.session as string;
      await waitMirror(
        session,
        "the CLI's mirror to be watching and in sync",
        's.status === "watching" && s.git?.status === "synced" && s.labels.copySide === "remote"',
      );
      const again = smd("worktrees", "mirror", "cli-sent");
      assert.equal(again.doc.alreadyMirrored, true);
      assert.equal(again.doc.session, session);
      writeFileSync(join(back.path, "agent.txt"), "written by the agent\n");
      await waitFor(
        () =>
          fileEquals(join(copy.path, "agent.txt"), "written by the agent\n"),
        "the agent's file to reach the copy on b",
        30_000,
      );
      git(back.path, "add", "-A");
      git(back.path, "commit", "-q", "-m", "Committed by the agent");
      const tip = gitOut(back.path, "rev-parse", "HEAD");
      await waitFor(
        () => gitOut(copy.path, "rev-parse", "HEAD") === tip,
        "the agent's commit to be followed on b",
        60_000,
      );
      await waitMirror(
        session,
        "the pair to agree again",
        's.git?.status === "synced"',
      );
      const running = smd("worktrees", "mirrors").doc as Doc & {
        mirrors: { session: string; copySide: string; git?: string }[];
      };
      const row = need(
        running.mirrors.find((mirror) => mirror.session === session),
        "the mirror in `smd worktrees mirrors`",
      );
      assert.equal(row.copySide, "remote");
      assert.equal(row.git, "synced");
      const stopped = smd("worktrees", "unmirror", "cli-sent");
      assert.equal(stopped.code, 0, JSON.stringify(stopped.doc));
      await waitFor(
        () => !existsSync(copy.path),
        "b's copy to go with the unmirror",
        30_000,
      );
      assert.ok(existsSync(back.path), "the unmirror removed a's original");

      // mirror --from: one of b's worktrees is copied here and kept in
      // step, b named as a person would. The unmirror removes a's copy
      // and leaves b's original.
      const projectOnB = need(
        (await b.evaluate<Project[]>("window.api.projects.list()")).find(
          (p) => p.name === "shared",
        ),
        "b's own project",
      );
      const { worktree: theirs } = await b.evaluate<{ worktree: Worktree }>(
        `window.api.worktrees.create(${JSON.stringify({
          projectId: projectOnB.id,
          branchName: "cli/theirs",
          worktreeName: "cli-theirs",
        })})`,
      );
      writeFileSync(join(theirs.path, "README.md"), "edited on b\n");
      const inbound = smd(
        "worktrees",
        "mirror",
        "cli/theirs",
        "--from",
        rowB.name,
        "--no-setup",
      );
      assert.equal(inbound.code, 0, JSON.stringify(inbound.doc));
      const here = need(inbound.doc.worktree, "the inbound mirror's copy");
      assert.ok(here.path.startsWith(realpathSync(fixture.a.dataDir)));
      assert.equal(readOrNull(join(here.path, "README.md")), "edited on b\n");
      await waitMirror(
        inbound.doc.session as string,
        "the inbound mirror to be watching and in sync",
        's.status === "watching" && s.git?.status === "synced" && s.labels.copySide !== "remote"',
      );
      writeFileSync(join(here.path, "agent.txt"), "the agent took over\n");
      await waitFor(
        () =>
          fileEquals(join(theirs.path, "agent.txt"), "the agent took over\n"),
        "the agent's file to reach b's original",
        30_000,
      );
      const released = smd("worktrees", "unmirror", here.path);
      assert.equal(released.code, 0, JSON.stringify(released.doc));
      await waitFor(
        () => !existsSync(here.path),
        "a's copy to go with the unmirror",
        30_000,
      );
      assert.ok(existsSync(theirs.path), "the unmirror removed b's original");
    });

    // The mirror the other way, as the local page's "Mirror to"
    // drives it: a copy of one of a's worktrees is made on b and kept
    // in step from a, which runs the session. Files and commits move
    // both ways, and the stop removes b's copy, never a's original.
    await scenario("mirror to a peer", async () => {
      const own = await ownProjectOnA();
      const { worktree: source } = await a.evaluate<{ worktree: Worktree }>(
        `window.api.worktrees.create(${JSON.stringify({
          projectId: own.id,
          branchName: "edge/mirror-to",
          worktreeName: "src-mirror-to",
        })})`,
      );
      writeFileSync(join(source.path, "README.md"), "edited on a\n");
      writeFileSync(join(source.path, ".env"), "SECRET=a\n");
      // Staged on the original, which the first reconcile must take as
      // the reference: the copy's index starts out unstaged.
      git(source.path, "add", "README.md");
      const started = await a.evaluate<PullResult & { session: string }>(
        `window.api.mirror.startTo(${JSON.stringify({
          targetDeviceId: idB,
          projectId: own.id,
          worktreeId: source.id,
          runSetup: false,
          ignoreMode: "everything",
          ignores: [],
        })})`,
      );
      const copy = started.worktree;
      assert.ok(
        copy.path.startsWith(realpathSync(fixture.b.dataDir)),
        `the copy landed outside b's data dir: ${copy.path}`,
      );
      assert.equal(readOrNull(join(copy.path, "README.md")), "edited on a\n");
      await waitMirror(
        started.session,
        "the mirror to a peer to be watching and in sync",
        's.status === "watching" && s.git?.status === "synced" && s.labels.copySide === "remote"',
      );
      await waitFor(
        () => fileEquals(join(copy.path, ".env"), "SECRET=a\n"),
        "a's ignored file to reach the copy on b",
        30_000,
      );
      assert.equal(
        gitOut(source.path, "diff", "--cached", "--name-only"),
        "README.md",
        "the mirror unstaged the original's work",
      );
      await waitFor(
        () =>
          gitOut(copy.path, "diff", "--cached", "--name-only") === "README.md",
        "the original's staging to reach the copy",
        30_000,
      );
      writeFileSync(join(copy.path, "from-b.txt"), "written on b\n");
      await waitFor(
        () => fileEquals(join(source.path, "from-b.txt"), "written on b\n"),
        "a file written on the copy to reach the original",
        30_000,
      );
      git(copy.path, "add", "-A");
      git(copy.path, "commit", "-q", "-m", "Committed on b");
      const tipOnB = gitOut(copy.path, "rev-parse", "HEAD");
      await waitFor(
        () => gitOut(source.path, "rev-parse", "HEAD") === tipOnB,
        "b's commit to be followed on a",
        60_000,
      );
      await waitMirror(
        started.session,
        "the pair to agree again",
        's.git?.status === "synced"',
      );
      await mirrorOp("stop", started.session);
      await waitFor(
        () => !existsSync(copy.path),
        "b's copy to go with the stop",
        30_000,
      );
      assert.ok(existsSync(source.path), "the stop removed a's original");
      await a.waitFor(
        "a's session list to empty after the stop",
        "window.api.mirror.list().then((m) => m.sessions.length === 0)",
        30_000,
      );
    });

    // A mirror that leaves gitignored files out, with setup on (that
    // rule's default): each side builds and keeps its own ignored
    // files, tracked work still moves both ways, and pause holds it.
    await scenario("mirror: gitignored rule, setup on, pause", async () => {
      const source = await sourceOnB("mirror-gi");
      const project = need(bProject, "the remote read");
      const ignored = (await onPeer(a, idB, "sync:ignoredPaths", {
        projectId: project.id,
        worktreeId: source.id,
      })) as { patterns: string[] };
      const started = await mirrorHere(source, {
        runSetup: true,
        ignoreMode: "gitignored",
        ignores: ignored.patterns,
      });
      const local = started.worktree;
      assert.ok(setupRuns().includes(local.path), "the setup script never ran");
      await waitMirror(
        started.session,
        "the gitignored mirror to be watching",
        's.status === "watching" && s.ignoreMode === "gitignored"',
      );
      writeFileSync(join(source.path, "tracked.txt"), "from b\n");
      await waitFor(
        () => fileEquals(join(local.path, "tracked.txt"), "from b\n"),
        "b's tracked file to reach a under the gitignored rule",
        30_000,
      );
      assert.equal(
        readOrNull(join(local.path, "build-out", "artifact.txt")),
        BUILT_ON_A,
        "the copy's build output was replaced by the source's",
      );
      assert.equal(
        readOrNull(join(source.path, "build-out", "artifact.txt")),
        "built on b\n",
        "the source's build output was replaced by the copy's",
      );
      assert.ok(
        !existsSync(join(local.path, ".env")),
        "an ignored file crossed",
      );

      // Paused, nothing moves. Resumed, what was held crosses.
      await mirrorOp("pause", started.session);
      await waitMirror(started.session, "the mirror to pause", "s.paused");
      writeFileSync(join(source.path, "while-paused.txt"), "held\n");
      await new Promise((resolve) => setTimeout(resolve, 4000));
      assert.ok(
        !existsSync(join(local.path, "while-paused.txt")),
        "a paused mirror still carried a file",
      );
      await mirrorOp("resume", started.session);
      await waitFor(
        () => fileEquals(join(local.path, "while-paused.txt"), "held\n"),
        "the held file to cross after the resume",
        60_000,
      );
      await mirrorOp("stop", started.session);
      await waitFor(
        () => !existsSync(local.path),
        "the copy to go with the stop",
        30_000,
      );
    });

    // Both sides commit while the mirror is paused: the pair is
    // diverged, neither history is touched, and Stop refuses because
    // it would take the copy's commit with it. Deleting the copy from
    // its page is the way out, and that ends the session on both ends.
    await scenario("mirror: diverged stop is refused", async () => {
      const source = await sourceOnB("mirror-div");
      const started = await mirrorHere(source, {
        runSetup: false,
        ignoreMode: "everything",
        ignores: [],
      });
      const local = started.worktree;
      await waitMirror(
        started.session,
        "the mirror to be watching and in sync",
        's.status === "watching" && s.git?.status === "synced"',
      );
      await mirrorOp("pause", started.session);
      await waitMirror(started.session, "the mirror to pause", "s.paused");
      writeFileSync(join(local.path, "on-a.txt"), "a\n");
      git(local.path, "add", "on-a.txt");
      git(local.path, "commit", "-q", "-m", "on a");
      writeFileSync(join(source.path, "on-b.txt"), "b\n");
      git(source.path, "add", "on-b.txt");
      git(source.path, "commit", "-q", "-m", "on b");
      const [tipA, tipB] = [local.path, source.path].map((path) =>
        gitOut(path, "rev-parse", "HEAD"),
      );
      await mirrorOp("resume", started.session);
      await waitMirror(
        started.session,
        "the pair to read as diverged",
        's.git?.status === "diverged"',
      );
      assert.equal(gitOut(local.path, "rev-parse", "HEAD"), tipA);
      assert.equal(gitOut(source.path, "rev-parse", "HEAD"), tipB);
      const refused = await refusalOf(mirrorOp("stop", started.session));
      assert.match(
        errorMessageOf(refused),
        /not confirmed in step with the other device \(diverged\)/,
      );
      assert.ok(existsSync(local.path), "a refused stop removed the copy");
      assert.ok(
        (await mirrorsOn(a)).sessions.some(
          (s) => s.session === started.session,
        ),
        "a refused stop ended the session",
      );
      await a.evaluate(
        `window.api.worktrees.delete(${JSON.stringify({
          projectId: local.projectId,
          worktreeId: local.id,
          force: true,
        })})`,
      );
      await a.waitFor(
        "the delete to end a's session",
        `window.api.mirror.list().then((m) => !m.sessions.some((s) => s.localWorktreeId === ${JSON.stringify(local.id)}))`,
        30_000,
      );
      await b.waitFor(
        "b to stop serving the deleted copy",
        `window.api.mirror.list().then((m) => !m.serving.some((s) => s.worktreeId === ${JSON.stringify(source.id)}))`,
        30_000,
      );
      assert.equal(gitOut(source.path, "rev-parse", "HEAD"), tipB);
    });

    // ---- The same flows through the real dialogs: the sidebar row,
    // the footer button, the rule picker and the setup switch, then
    // Start. What the switch shows is what the create must do.
    const SETUP_SWITCH = `document.querySelector('[role="switch"][aria-label="Run the setup script"]')`;
    const click = (what: string, element: string) =>
      a.waitFor(
        what,
        `(() => { const el = ${element}; if (!el || el.closest(${NOT_CLICKABLE})) return false; el.click(); return true; })()`,
        30_000,
      );
    const clickText = (text: string) => click(text, byText(text));
    const waitSwitch = (checked: boolean, why: string) =>
      a.waitFor(
        `the setup switch to read ${checked ? "on" : "off"} (${why})`,
        `${SETUP_SWITCH}?.getAttribute("aria-checked") === ${JSON.stringify(String(checked))}`,
        30_000,
      );
    const openDialogFor = async (source: Worktree, button: string) => {
      await click(`the sidebar row of ${source.branch}`, byText(source.branch));
      await click(`the ${button} button`, byText(button));
      await a.waitFor(
        "the review to show the setup switch",
        `${SETUP_SWITCH} !== null`,
        30_000,
      );
    };
    // Clicks Start and reads the running view's setup row in the same
    // breath, since the run it belongs to lasts a few seconds.
    const startAndReadSetupRow = async (start: string) => {
      await a.waitFor(
        `${start} to be enabled`,
        `(() => { const el = ${byText(start)}; return Boolean(el) && !el.closest(${NOT_CLICKABLE}); })()`,
        30_000,
      );
      return a.evaluate<string>(
        `(async () => {
          ${byText(start)}.click();
          for (let tries = 0; tries < 400; tries += 1) {
            const row = [...document.querySelectorAll("li")].find((el) => el.textContent.includes("Run the setup script"));
            if (row) return row.textContent;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          throw new Error("the running view never listed the setup step");
        })()`,
      );
    };
    const landedOnA = async (source: Worktree): Promise<Worktree> => {
      const aProject = await ownProjectOnA();
      const list = await a.evaluate<Worktree[]>(
        `window.api.worktrees.list(${JSON.stringify(aProject.id)})`,
      );
      return need(
        list.find((w) => w.branch === source.branch),
        `a's copy of ${source.branch}`,
      );
    };

    // The mirror dialog left alone: nothing is left out, so the switch
    // sits off, follows the rule to on and back, and the create it
    // starts runs no setup.
    await scenario("dialog: mirror with the default switch", async () => {
      const source = await sourceOnB("ui-mirror");
      await openDialogFor(source, "Mirror here");
      await waitSwitch(false, "nothing is left out");
      await click("the Gitignored rule", byText("Gitignored"));
      await waitSwitch(true, "gitignored files stay behind");
      await click("the Nothing rule", byText("Nothing"));
      await waitSwitch(false, "back to nothing left out");
      assert.match(
        await startAndReadSetupRow("Start mirroring"),
        /skipped/,
        "the running view did not list setup as skipped",
      );
      await a.waitFor(
        "the mirror dialog to reach its live step",
        `Boolean(${byText("Open here")})`,
        120_000,
      );
      const local = await landedOnA(source);
      assert.ok(
        !setupRuns().includes(local.path),
        "the dialog's default-off switch still ran the setup script",
      );
      const session = need(
        (await mirrorsOn(a)).sessions.find(
          (s) => s.localWorktreeId === local.id,
        ),
        "the session the dialog started",
      );
      assert.equal(session.ignoreMode, "everything");
      await clickText("Open here");
      await mirrorOp("stop", session.session);
      await waitFor(
        () => !existsSync(local.path),
        "the copy to go with the stop",
        30_000,
      );
    });

    // The transplant dialog with the switch pinned against the rule:
    // Gitignored turns it on, the user turns it off, and it stays off
    // through further rule changes and into the create.
    await scenario(
      "dialog: transplant with the switch pinned off",
      async () => {
        const source = await sourceOnB("ui-pinned");
        await openDialogFor(source, "Transplant here");
        await waitSwitch(false, "nothing is left out");
        await click("the Gitignored rule", byText("Gitignored"));
        await waitSwitch(true, "gitignored files stay behind");
        await click("the setup switch", SETUP_SWITCH);
        await waitSwitch(false, "the user turned it off");
        await click("the Nothing rule", byText("Nothing"));
        await click("the Gitignored rule", byText("Gitignored"));
        await waitSwitch(false, "a pinned switch ignores the rule");
        assert.match(
          await startAndReadSetupRow("Start transplant"),
          /skipped/,
          "the running view listed a pinned-off setup as running",
        );
        await a.waitFor(
          "the transplant dialog to reach its finish step",
          `Boolean(${byText("Decide later")})`,
          120_000,
        );
        const local = await landedOnA(source);
        assert.ok(
          !setupRuns().includes(local.path),
          "a switch pinned off still ran the setup script",
        );
        assert.ok(
          !existsSync(join(local.path, ".env")),
          "the gitignored rule let an ignored file cross",
        );
        assert.ok(
          !existsSync(join(local.path, "build-out")),
          "build output appeared with setup off and gitignored left out",
        );
        await clickText("Decide later");
        assert.ok(existsSync(source.path), "Decide later removed the source");
      },
    );

    // The switch pinned on with nothing left out: setup runs, and the
    // copy keeps its own build output over the source's.
    await scenario("dialog: transplant with the switch pinned on", async () => {
      const source = await sourceOnB("ui-on");
      await openDialogFor(source, "Transplant here");
      await waitSwitch(false, "nothing is left out");
      await click("the setup switch", SETUP_SWITCH);
      await waitSwitch(true, "the user turned it on");
      const setupRow = await startAndReadSetupRow("Start transplant");
      assert.ok(
        setupRow.includes("build-out/artifact.txt") &&
          !setupRow.includes("skipped"),
        `the running view did not name the setup command: ${setupRow}`,
      );
      await a.waitFor(
        "the transplant dialog to reach its finish step",
        `Boolean(${byText("Decide later")})`,
        120_000,
      );
      const local = await landedOnA(source);
      assert.ok(
        setupRuns().includes(local.path),
        "a switch pinned on did not run the setup script",
      );
      assert.equal(
        readOrNull(join(local.path, "build-out", "artifact.txt")),
        BUILT_ON_A,
      );
      assert.equal(readOrNull(join(local.path, ".env")), "SECRET=b\n");
      await clickText("Decide later");
    });

    // The other direction through its dialog: the local page's
    // "Transplant to…", which opens on its one ready device (b), the
    // destination's facts read from that device, and the finish step
    // tearing down a's source and leaving for the copy's page on b.
    await scenario("dialog: transplant to a peer", async () => {
      const own = await ownProjectOnA();
      const { worktree: source } = await a.evaluate<{ worktree: Worktree }>(
        `window.api.worktrees.create(${JSON.stringify({
          projectId: own.id,
          branchName: "edge/ui-sent",
          worktreeName: "src-ui-sent",
        })})`,
      );
      writeFileSync(join(source.path, "README.md"), "edited on a\n");
      // A create through the raw bridge skips the renderer's own
      // mutation, whose success is what re-lists the sidebar. The
      // refetch a returning window makes stands in for it: a blur and
      // a focus, since only the transition counts, and again until the
      // row is there, since a list still fresh is not re-read.
      await a.waitFor(
        "a's sidebar to list the new worktree",
        `(window.dispatchEvent(new Event("blur")), window.dispatchEvent(new Event("focus")), Boolean(${byText("edge/ui-sent")}))`,
        120_000,
      );
      await openDialogFor(source, "Transplant to…");
      await a.waitFor(
        "the review to name b as the destination",
        `Boolean(${byText("destination")})`,
        30_000,
      );
      await clickText("Start transplant");
      await a.waitFor(
        "the dialog to reach its finish step",
        `Boolean(${byText("Decide later")})`,
        120_000,
      );
      const landed = need(
        (
          (await onPeer(a, idB, "worktrees:list", {
            projectId: need(bProject, "the remote read").id,
          })) as Worktree[]
        ).find((w) => w.branch === "edge/ui-sent"),
        "the copy on b",
      );
      assert.equal(readOrNull(join(landed.path, "README.md")), "edited on a\n");
      await clickText("Tear it down");
      await clickText("Tear down and finish");
      await clickText("Click again to confirm");
      await waitFor(
        () => !existsSync(source.path),
        "a's source to go with the teardown",
        60_000,
      );
      // The router keeps its place in memory, so the page is read off
      // what it shows: the copy's branch, under a peer's footer.
      await a.waitFor(
        "the app to leave for the copy's page on b",
        `[...document.querySelectorAll("h1")].some((h) => h.textContent.trim() === "edge/ui-sent") && Boolean(${byText("Transplant here")})`,
        30_000,
      );
    });

    await scenario("port forward", async () => {
      // server.close waits out live connections, so the accepted ones
      // are tracked and destroyed first or a failed run would hang.
      const conns = new Set<Socket>();
      const echo = createServer((socket) => {
        conns.add(socket);
        socket.on("close", () => conns.delete(socket));
        socket.pipe(socket);
      });
      await new Promise<void>((resolve) =>
        echo.listen(0, "127.0.0.1", resolve),
      );
      const remotePort = (echo.address() as { port: number }).port;
      try {
        const forward = await a.evaluate<{
          forwardId: string;
          localPort: number;
        }>(
          `window.api.portForward.start(${JSON.stringify({ deviceId: idB, remotePort })})`,
        );
        const client = connect(forward.localPort, "127.0.0.1", () =>
          client.write("ping"),
        );
        const timer = setTimeout(
          () => client.destroy(new Error("no echo within 10s")),
          10_000,
        );
        const echoed = await new Promise<string>((resolve, reject) => {
          client.once("data", (data) => resolve(data.toString()));
          client.once("error", reject);
        }).finally(() => {
          clearTimeout(timer);
          client.destroy();
        });
        assert.equal(echoed, "ping", "echo returned something else");
        await a.evaluate(
          `window.api.portForward.stop(${JSON.stringify(forward.forwardId)})`,
        );
      } finally {
        for (const conn of conns) conn.destroy();
        echo.close();
      }
    });

    // The add-project flow's reach onto a machine that doesn't have the
    // repo: a asks b to clone a remote and register it. The remote is a
    // git daemon on loopback, because the payload (rightly) takes no
    // path for one. Placed after every scenario that reads b's project
    // list, which this one grows.
    await scenario("clone onto a peer", async () => {
      const served = join(runDir, "served");
      const solo = join(runDir, "solo");
      mkdirSync(served, { recursive: true });
      mkdirSync(solo, { recursive: true });
      git(solo, "init", "-q", "-b", "main");
      writeFileSync(join(solo, "README.md"), "cloned onto a peer\n");
      git(solo, "add", ".");
      git(solo, "commit", "-q", "-m", "Solo");
      git(served, "clone", "-q", "--bare", solo, "solo.git");
      const port = await freeLoopbackPort();
      const daemon = spawn(
        "git",
        [
          "daemon",
          `--base-path=${served}`,
          "--export-all",
          "--listen=127.0.0.1",
          `--port=${port}`,
          "--reuseaddr",
          served,
        ],
        { env: gitEnv, stdio: "ignore" },
      );
      const url = `git://127.0.0.1:${port}/solo.git`;
      const clone = (input: Record<string, unknown>) =>
        onPeer(a, idB, "projects:clone", input) as Promise<Project>;
      try {
        await waitFor(() => {
          try {
            git(runDir, "ls-remote", url);
            return true;
          } catch {
            return false;
          }
        }, "the git daemon to serve");

        // Gated like every command: a peer that takes none clones none,
        // and its disk stays closed to the folder picker too.
        await b.evaluate("window.api.account.setAcceptsCommands(false)");
        for (const refused of [
          await refusalOf(clone({ url, parentDir: fixture.b.repos })),
          await refusalOf(
            onPeer(a, idB, "fs:listDirectory", { path: fixture.b.repos }),
          ),
        ]) {
          assert.ok(refused !== null, "served with commands off");
          assert.ok(
            isCommandRefusedError(refused),
            `unexpected refusal: ${errorMessageOf(refused)}`,
          );
        }
        await b.evaluate("window.api.account.setAcceptsCommands(true)");

        // Held to remotes on b's side of the wire, whatever a sends: an
        // option-shaped string and a path on b's own disk both bounce.
        const marker = join(runDir, "clone-injected");
        const bounced = await Promise.all(
          [`--upload-pack=touch ${marker}`, fixture.origin].map((bad) =>
            refusalOf(clone({ url: bad, parentDir: fixture.b.repos })),
          ),
        );
        assert.ok(
          bounced.every((refused) => refused !== null),
          "b cloned something that is not a remote",
        );
        assert.ok(!existsSync(marker), "an option-shaped URL ran");

        const project = await clone({ url, parentDir: fixture.b.repos });
        const dest = join(fixture.b.repos, "solo");
        assert.equal(project.path, realpathSync(dest));
        assert.equal(
          readFileSync(join(dest, "README.md"), "utf8"),
          "cloned onto a peer\n",
        );
        const listed = (await onPeer(a, idB, "projects:list")) as Project[];
        const mine = listed.find((entry) => entry.id === project.id);
        assert.ok(mine, "the clone is not in b's project list");
        assert.ok(
          mine.identity?.startsWith("root:"),
          "the clone has no identity",
        );

        // The remote another device would clone it from reads back. The
        // shared repo's origin is a path, which is nobody else's remote.
        assert.equal(
          await onPeer(a, idB, "projects:cloneUrl", { projectId: project.id }),
          url,
        );
        assert.equal(
          await onPeer(a, idB, "projects:cloneUrl", {
            projectId: need(bProject, "the remote read").id,
          }),
          null,
        );

        // Never onto something that is already there.
        const again = await refusalOf(
          clone({ url, parentDir: fixture.b.repos }),
        );
        assert.match(errorMessageOf(again), /already exists/);
      } finally {
        daemon.kill();
      }
    });

    await scenario("liveness", async () => {
      // SIGKILL to the whole peer tree: the wrapper cannot be tidy
      // about it, and Electron dies mid-socket, which is the event.
      b.close();
      windows.splice(windows.indexOf(b), 1);
      await killTrees([need(peer ?? undefined, "a running peer")], "SIGKILL");
      await waitDropped(a, idB, "a to drop b from its roster after the kill");
      launchPeer();
      b = await attachWindow(portB, 120_000);
      windows.push(b);
      await waitSignedIn(b, "b (relaunched)");
      await Promise.all([
        waitConnected(a, idB, "a (after b's relaunch)"),
        waitConnected(b, idA, "b (relaunched)"),
      ]);
    });

    // A pick made while the other device was off reaches it when the
    // session next lands, with nothing in between to have held it.
    await scenario("shared settings: offline catch-up", async () => {
      b.close();
      windows.splice(windows.indexOf(b), 1);
      await killTrees([need(peer ?? undefined, "a running peer")], "SIGKILL");
      await waitDropped(a, idB, "a to drop b from its roster");
      await setSharedSetting(a, "picked-while-b-was-off");
      launchPeer();
      b = await attachWindow(portB, 120_000);
      windows.push(b);
      await waitSignedIn(b, "b (relaunched again)");
      await waitSharedSetting(
        b,
        "picked-while-b-was-off",
        "b to catch up after its relaunch",
      );
    });

    await scenario("revoke", async () => {
      // a removes b from the account, as a person does on the Devices
      // page. Not a self sign-out over the bridge: b relaunched with
      // its credential on disk, so ClerkAccountSync holds a live Clerk
      // session with no enrollment attempt armed and would re-enroll
      // b the moment the credential cleared (the Sign out button ends
      // the Clerk session first, which a cloned window cannot). Revoked
      // from a, b keeps its dead credential and stays gone.
      // b runs a port forward onto a first: the remote setup a device
      // leaves behind, which its sign-out must tear down with it. The
      // forward's open rides a's grant, which the boot leaves off, and
      // the mirror onto b below rides b's.
      await a.evaluate("window.api.account.setAcceptsCommands(true)");
      await b.evaluate("window.api.account.setAcceptsCommands(true)");
      const forward = await b.evaluate<{ forwardId: string }>(
        `window.api.portForward.start(${JSON.stringify({ deviceId: idA, remotePort: 1 })})`,
      );
      // And mirrors both ways: one a runs onto b (its copy on b), one
      // b runs from a (its copy on b). A mirror pairs two devices of
      // the account, so both end with b's membership, the copies kept
      // as plain worktrees. A shared setting picked on b goes with the
      // membership too, while a's copy keeps it.
      const own = await ownProjectOnA();
      const { worktree: source } = await a.evaluate<{ worktree: Worktree }>(
        `window.api.worktrees.create(${JSON.stringify({
          projectId: own.id,
          branchName: "edge/revoke-mirror",
          worktreeName: "src-revoke-mirror",
        })})`,
      );
      const toB = await a.evaluate<{ worktree: Worktree; session: string }>(
        `window.api.mirror.startTo(${JSON.stringify({
          targetDeviceId: idB,
          projectId: own.id,
          worktreeId: source.id,
          runSetup: false,
          ignoreMode: "everything",
          ignores: [],
        })})`,
      );
      const { worktree: source2 } = await a.evaluate<{ worktree: Worktree }>(
        `window.api.worktrees.create(${JSON.stringify({
          projectId: own.id,
          branchName: "edge/revoke-mirror-from",
          worktreeName: "src-revoke-mirror-from",
        })})`,
      );
      const fromA = await b.evaluate<{ worktree: Worktree; session: string }>(
        `window.api.mirror.start(${JSON.stringify({
          sourceDeviceId: idA,
          sourceProjectId: own.id,
          sourceWorktreeId: source2.id,
          sourceIdentity: own.identity,
          branch: source2.branch,
          runSetup: false,
          ignoreMode: "everything",
          ignores: [],
        })})`,
      );
      await a.waitFor(
        "a's mirror onto b to be watching",
        `window.api.mirror.list().then((m) => m.sessions.some((s) => s.session === ${JSON.stringify(toB.session)} && s.status === "watching"))`,
        90_000,
      );
      await b.waitFor(
        "b's mirror from a to be watching",
        `window.api.mirror.list().then((m) => m.sessions.some((s) => s.session === ${JSON.stringify(fromA.session)} && s.status === "watching"))`,
        90_000,
      );
      await setSharedSetting(b, "picked-on-b-before-revoke");
      await waitSharedSetting(a, "picked-on-b-before-revoke", "a to take b's");
      await a.evaluate(
        `window.api.account.revokeDevice(${JSON.stringify(idB)})`,
      );
      await waitDropped(a, idB, "a to drop b after revoking it");
      const devices = await a.evaluate<{ deviceId: string }[]>(
        "window.api.account.listDevices()",
      );
      assert.ok(
        !devices.some((d) => d.deviceId === idB),
        "b still in a's device registry",
      );
      // A removed device signs itself out (a dev profile drops the
      // account layer only, keeping the cloned Clerk session alive for
      // the other windows).
      await b.waitFor(
        "b to sign itself out of the account",
        "window.api.account.status().then((s) => !s.signedIn)",
        60_000,
      );
      // Signed out, b has no account to reach: its hub socket is
      // stopped (not backing off toward a redial), every direct
      // session is closed from its own side, its roster is empty, and
      // the forward it ran is gone with them.
      await b.waitFor(
        "b's hub socket to stop and its direct sessions to close",
        "window.api.hub.status().then((s) => s.socket.phase === 'stopped' && Object.keys(s.peerAppVersions).length === 0 && s.onlineDeviceIds.length === 0)",
        30_000,
      );
      const forwards = await b.evaluate<{ forwards: { forwardId: string }[] }>(
        "window.api.portForward.list()",
      );
      assert.ok(
        !forwards.forwards.some((f) => f.forwardId === forward.forwardId),
        "b's port forward survived its sign-out",
      );
      await b.waitFor(
        "b's device tabs to go with the account",
        'document.querySelectorAll(\'[role="tablist"][aria-label="Device"]\').length === 0',
        30_000,
      );
      // The mirrors end on both sides: b's with its sign-out, a's off
      // the registry read above that no longer lists b. Both copies on
      // b stay as worktrees, and b's shared settings are gone while
      // a's copy still holds the pick.
      await b.waitFor(
        "b's mirror to end with its sign-out",
        "window.api.mirror.list().then((m) => m.sessions.length === 0)",
        30_000,
      );
      await a.waitFor(
        "a's mirror onto b to end once the registry no longer lists b",
        `window.api.mirror.list().then((m) => !m.sessions.some((s) => s.session === ${JSON.stringify(toB.session)}))`,
        30_000,
      );
      assert.ok(existsSync(toB.worktree.path), "a's copy on b was removed");
      assert.ok(existsSync(fromA.worktree.path), "b's copy was removed");
      const historyA = await a.evaluate<{
        events: { kind: string; detail: string }[];
      }>(
        `window.api.mirror.history(${JSON.stringify({ localWorktreeId: source.id })})`,
      );
      assert.ok(
        historyA.events.some(
          (event) =>
            event.kind === "stopped" &&
            event.detail.includes("left the account"),
        ),
        "a's mirror thread does not say why it ended",
      );
      const docB = await b.evaluate<{ entries: Record<string, unknown> }>(
        "window.api.sharedSettings.read()",
      );
      assert.equal(
        docB.entries[SHARED_KEY],
        undefined,
        "b kept the account's shared settings after signing out",
      );
      await waitSharedSetting(
        a,
        "picked-on-b-before-revoke",
        "a to keep the pick",
      );
    });
    await shoot("end");
  } catch (error) {
    failures.push(`setup: ${errorMessageOf(error)}`);
    log(`FAIL setup: ${errorMessageOf(error)}`);
    await shoot("fail-setup");
  } finally {
    for (const w of windows) w.close();
    const trees = [primary, ...(peer ? [peer] : [])];
    if (keep) {
      log("--keep: leaving both windows and profiles up");
      // Let this process exit while the detached trees live on.
      for (const tree of trees) tree.unref();
    } else {
      // Revoke what is still enrolled, through fresh attachments so a
      // window this run lost track of (a relaunch that failed midway)
      // is still asked. From a: it removes every device of b's profile
      // (b may have re-enrolled, or never been read), then signs
      // itself out, which sticks because a booted fresh in this run
      // (see the revoke scenario for why b's would not). Without a, b
      // signs itself out as the best that is left. Best effort: a dead
      // window has nothing to revoke. Then stop both trees and wipe
      // the local halves.
      await revokeFrom(portA, devProfileNameSuffix(fixture.b.name)).catch(
        async (error: unknown) => {
          log(`cleanup: a could not revoke: ${errorMessageOf(error)}`);
          await revokeFrom(portB, devProfileNameSuffix(fixture.a.name)).catch(
            (fallbackError: unknown) => {
              log(
                `cleanup: b could not revoke: ${errorMessageOf(fallbackError)}`,
              );
            },
          );
        },
      );
      await killTrees(trees, "SIGTERM");
      // A cleared timer, so a prompt exit does not leave the loop
      // idling out the grace period after the report.
      let graceTimer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, 4000);
      });
      await Promise.race([Promise.all(trees.map(exited)), grace]);
      clearTimeout(graceTimer);
      await killTrees(trees, "SIGKILL");
      // Each wipe stands on its own, and none of them may decide the
      // run: a throw out of this finally would skip the report, so a
      // scenario summary this run spent minutes earning would be lost
      // to a stray file left behind. What is left over is named in the
      // log, and the next run wipes the profiles again before it seeds.
      for (const [what, wipe] of [
        [fixture.a.name, () => wipeDevProfile(fixture.a)],
        [fixture.b.name, () => wipeDevProfile(fixture.b)],
        ["the shared origin", () => rmTree(fixture.origin)],
      ] as const) {
        try {
          wipe();
        } catch (error) {
          log(`cleanup: couldn't remove ${what}: ${errorMessageOf(error)}`);
        }
      }
    }
  }
  return failures;
}

report({
  name: "remote smoke",
  failures: await main(),
  hint: `artifacts: ${runDir}`,
});
