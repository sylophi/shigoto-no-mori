// The remote flows, end to end, on one machine:
//
//   pnpm e2e:remote [--keep]
//
// Two dev profiles (scripts/lib/devProfile.mts) as two devices of the
// owner's dev account, both signed in by cloning the plain dev
// instance's sign-in, driven over CDP (cdp.mts) through the real
// device hub, direct plane and dev CLI. MANUAL-TESTING.md lists the
// scenarios and the prerequisites.
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalTree } from "../../host/lib/scripts/process.ts";
import { errorMessageOf } from "../../shared/errors.ts";
import { isCommandRefusedError } from "../../shared/ipc/socket/frames.ts";
import {
  freeLoopbackPort,
  repoRoot,
  report,
  scrubbedGitEnv,
} from "../lib/checkKit.mjs";
import {
  buildDevCli,
  cloneDevLogin,
  devProfilePaths,
  PROFILES_DIR,
  registerProjects,
  wipeDevProfile,
  type DevProfile,
} from "../lib/devProfile.mts";
import { attachWindow, type AppWindow } from "./cdp.mts";

const keep = process.argv.includes("--keep");
const runDir = join(tmpdir(), `sm-e2e-${Date.now()}`);
mkdirSync(runDir, { recursive: true });
const log = (line: string) => console.log(`[e2e] ${line}`);

type Fixture = { a: DevProfile; b: DevProfile; origin: string };

function prepareFixture(): Fixture {
  const a = devProfilePaths("e2e-a");
  const b = devProfilePaths("e2e-b");
  wipeDevProfile(a);
  wipeDevProfile(b);
  buildDevCli();

  const origin = join(PROFILES_DIR, "e2e-origin.git");
  rmSync(origin, { recursive: true, force: true });
  const gitEnv = {
    ...scrubbedGitEnv(),
    GIT_AUTHOR_NAME: "E2E",
    GIT_AUTHOR_EMAIL: "e2e@example.com",
    GIT_COMMITTER_NAME: "E2E",
    GIT_COMMITTER_EMAIL: "e2e@example.com",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" });
  const seed = join(runDir, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "e2e shared repo\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "Initial");
  git(seed, "init", "--bare", "-q", "-b", "main", origin);
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");

  for (const profile of [a, b]) {
    mkdirSync(profile.repos, { recursive: true });
    mkdirSync(profile.root, { recursive: true });
    git(profile.repos, "clone", "-q", origin, "shared");
    registerProjects(profile, profile.repos);
    cloneDevLogin(profile);
  }
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

type Project = { id: string; name: string; identity?: string | null };
type Worktree = { id: string; branch: string; path: string };

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

    let created: Worktree | undefined;
    await scenario("grant gate", async () => {
      const project = need(bProject, "the remote read");
      const create = () =>
        onPeer(a, idB, "worktrees:create", {
          projectId: project.id,
          branchName: "feat/e2e",
        }) as Promise<{ worktree: Worktree }>;
      await b.evaluate("window.api.account.setAcceptsCommands(false)");
      const refused = await create().then(
        () => null,
        (error: unknown) => error,
      );
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
    await scenario("bring here", async () => {
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
        pulled.path.startsWith(fixture.a.root),
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

    await scenario("sign-out", async () => {
      await b.evaluate("window.api.account.signOut()");
      await waitDropped(a, idB, "a to drop b after b signed out");
      const devices = await a.evaluate<{ deviceId: string }[]>(
        "window.api.account.listDevices()",
      );
      assert.ok(
        !devices.some((d) => d.deviceId === idB),
        "b still in a's device registry",
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
      // is still asked. Best effort: a dead window has nothing to
      // revoke. Then stop both trees and wipe the local halves.
      await Promise.allSettled(
        [portA, portB].map(async (port) => {
          const w = await attachWindow(port, 5_000);
          try {
            await w.evaluate("window.api.account.signOut()");
          } finally {
            w.close();
          }
        }),
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
      wipeDevProfile(fixture.a);
      wipeDevProfile(fixture.b);
      rmSync(fixture.origin, { recursive: true, force: true });
    }
  }
  return failures;
}

report({
  name: "remote smoke",
  failures: await main(),
  hint: `artifacts: ${runDir}`,
});
