// Durable proof for the worktree port list's parts, under plain Node
// with no Electron:
//   - every worktree's port-pool rows are the ports port-pool wrote into
//     its env files, the external ones' and the primary's too, read as
//     `sm worktrees status` reads them (port-pool's own state saying
//     otherwise is not read, a name only a URL carries included), in the
//     declared order; only a managed one counts as sm's to provision and
//     release.
//   - with port-pool off, whether it is active asks git nothing.
//   - the merge (shared/ports/mergeWorktreePorts.ts) lists pool rows first and
//     shadows a custom row on a pool-allocated number.
//   - the loopback probe and dial (host/lib/net.ts) see a listener on
//     127.0.0.1, fall back to ::1 for a v6-only listener, and report a
//     closed port as not listening within the deadline.
// Run: pnpm test worktree-ports.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import * as Effect from "effect/Effect";
import * as EngineWorktrees from "@shigomori/engine/Worktrees";
import * as Ops from "@host/lib/engineOps";
import * as Ports from "@host/lib/Ports";
import { addProject } from "@host/lib/projects";
import { initDataDirAt } from "@shared/paths";
import { engineDataDir, runHost, serviceBuiltNow } from "./lib/hostRuntime.mts";
import { mergeWorktreePorts } from "@shared/ports/mergeWorktreePorts";
import { dialLoopback, isLoopbackPortListening } from "@host/lib/net";
import { errorCodeOf } from "@shigomori/contracts/errors";
import {
  freeLoopbackPort,
  makeTracker,
  sandboxGit,
  startLoopbackServer,
  tempDir,
  type Track,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";
import { afterAll, beforeAll, it } from "vitest";

const tracker = makeTracker();
afterAll(tracker.teardown);

async function listenOn(host: string, track: Track): Promise<number> {
  const server = await startLoopbackServer((socket) => socket.end(), { host });
  track(server.close);
  return server.port;
}

const git = sandboxGit();
// port-pool's config: web and api, written into .env.
const POOL_CONFIG = JSON.stringify({
  schemaVersion: 1,
  portNames: ["web", "api"],
  envFiles: { ".env": { PORT: "${web}", API_URL: "http://localhost:${api}" } },
});
const ENV = "PORT=4100\nAPI_URL=http://localhost:4200\n";

let projectId: string;
let repo: string;
let ports: Ports.Ports["Service"];
// A worktree of the project's at `at`, as port-pool would leave it.
const checkout = async (name: string, at: string) => {
  if (at !== repo) git(repo, "worktree", "add", "-q", "-b", name, at);
  writeFileSync(join(at, ".env"), ENV);
  const found = (await runHost(Ops.listWorktreeIdentities({ projectId }))).find(
    (row) => row.path === at,
  );
  assert.ok(found !== undefined, at);
  return { projectId, worktreeId: found.id };
};

// A project set up for port-pool, the device's toggle on, port-pool on
// PATH, and port-pool's own state naming other ports for every folder.
beforeAll(async () => {
  initDataDirAt(engineDataDir);
  const root = tempDir("sm-ports-", tracker.track);
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "port-pool.config.json"), POOL_CONFIG);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "a");
  projectId = (await runHost(addProject(repo))).id;
  await runHost(Ops.patchGlobalConfig({ portPool: true }));
  tracker.track(() => runHost(Ops.patchGlobalConfig({ portPool: false })));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "port-pool"), "#!/bin/sh\n");
  chmodSync(join(bin, "port-pool"), 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  tracker.track(() => {
    process.env["PATH"] = path;
  });
  const dataHome = join(root, "xdg");
  mkdirSync(join(dataHome, "port-pool"), { recursive: true });
  writeFileSync(
    join(dataHome, "port-pool", "state.json"),
    JSON.stringify({
      allocations: [
        repo,
        join(root, "owl"),
        ...["fox", "hare"].map((name) =>
          join(engineDataDir, "wt", "repo", name),
        ),
      ].map((dir) => ({ dir, ports: { web: 5100, api: 5200 } })),
    }),
  );
  process.env["XDG_DATA_HOME"] = dataHome;
  ports = await serviceBuiltNow(Ports.Ports, Ports.layer, tracker.track);
});

const poolRows = async (worktree: { projectId: string; worktreeId: string }) =>
  (await Effect.runPromise(ports.list(worktree)))
    .filter((row) => row.source === "pool")
    .map(({ label, port }) => ({ label, port }));
const active = (worktree: { projectId: string; worktreeId: string }) =>
  Effect.runPromise(ports.portPoolActive(worktree));
const DECLARED = [
  { label: "web", port: 4100 },
  { label: "api", port: 4200 },
];

it("rows: the primary and an external worktree show the ports port-pool wrote, and only a managed one is sm's to provision", async () => {
  const primary = await checkout("main", repo);
  const external = await checkout("owl", join(repo, "..", "owl"));
  const managed = await checkout(
    "fox",
    join(engineDataDir, "wt", "repo", "fox"),
  );
  assert.deepEqual(await poolRows(primary), DECLARED);
  assert.deepEqual(await poolRows(external), DECLARED);
  assert.deepEqual(await poolRows(managed), DECLARED);
  assert.equal(await active(primary), false);
  assert.equal(await active(external), false);
  assert.equal(await active(managed), true);
});

it("ports: the list and `sm worktrees status` read the env files port-pool wrote, the list in the declared order", async () => {
  const worktree = await checkout(
    "hare",
    join(engineDataDir, "wt", "repo", "hare"),
  );
  const card = await runHost(
    Effect.gen(function* () {
      const worktrees = yield* EngineWorktrees.Worktrees;
      const located = yield* worktrees.resolve(
        yield* worktrees.here("/"),
        worktree,
      );
      return yield* worktrees.status(located, { pullRequest: false });
    }),
  );
  assert.deepEqual(card.ports, [
    { name: "api", port: 4200, file: ".env", key: "API_URL" },
    { name: "web", port: 4100, file: ".env", key: "PORT" },
  ]);
  assert.deepEqual(await poolRows(worktree), DECLARED);
});

it("toggle: with port-pool off, whether it is active asks git nothing", async () => {
  const root = join(repo, "..");
  const quiet = join(root, "quiet");
  mkdirSync(quiet);
  git(quiet, "init", "-q", "-b", "main");
  git(quiet, "commit", "-q", "--allow-empty", "-m", "a");
  const project = await runHost(addProject(quiet));
  const [primary] = await runHost(
    Ops.listWorktreeIdentities({ projectId: project.id }),
  );
  assert.ok(primary !== undefined);
  // git on PATH as a stand-in that notes each run, then runs git.
  const real = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const bin = join(root, "git-bin");
  const asked = join(root, "git-asked");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\necho "$@" >> '${asked}'\nexec '${real}' "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env["PATH"];
  await runHost(Ops.patchGlobalConfig({ portPool: false }));
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  try {
    assert.equal(
      await active({ projectId: project.id, worktreeId: primary.id }),
      false,
    );
  } finally {
    process.env["PATH"] = path;
    await runHost(Ops.patchGlobalConfig({ portPool: true }));
  }
  assert.equal(existsSync(asked), false, "git was asked");
});

it("merge: pool rows first in declared order, a custom row on a pool number is shadowed", async () => {
  const merged = mergeWorktreePorts(
    [
      { name: "web", port: 4000 },
      { name: "api", port: 4100 },
    ],
    [
      { port: 4100, label: "old api" },
      { port: 9229, label: "inspector" },
      { port: 5555 },
    ],
  );
  assert.deepEqual(merged, [
    { port: 4000, label: "web", source: "pool" },
    { port: 4100, label: "api", source: "pool" },
    { port: 9229, label: "inspector", source: "custom" },
    { port: 5555, label: undefined, source: "custom" },
  ]);
});

it("probe: a 127.0.0.1 listener is seen, a closed port is not, within the deadline", async () => {
  const port = await listenOn("127.0.0.1", trackTest);
  assert.equal(await isLoopbackPortListening(port, 500), true);
  const closed = await freeLoopbackPort();
  const started = Date.now();
  assert.equal(await isLoopbackPortListening(closed, 500), false);
  assert.ok(Date.now() - started < 500, "a refused dial answers at once");
});

it("dial: a v6-only listener is reached through the ::1 fallback", async () => {
  let port;
  try {
    port = await listenOn("::1", trackTest);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
      console.log("(no IPv6 loopback on this machine, fallback not exercised)");
      return;
    }
    throw error;
  }
  const socket = await dialLoopback(port, 500);
  trackTest(() => socket.destroy());
  assert.equal(socket.remoteAddress, "::1");
  assert.equal(await isLoopbackPortListening(port, 500), true);
});
