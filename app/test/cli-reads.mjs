// Durable proof for the host reading the data model through the CLI
// (host/ipc/cliDelegate.ts): the REAL sm binary built from cli/
// (test/lib/smBinary.mjs) answers the REAL IPC handlers against real
// fixture repos in a sandboxed data dir. Asserts:
//   - the two rules the app still mirrors on its side hold against the
//     CLI's own answers: worktreeIdFromPath against the ids the CLI
//     prints, and the renderer's layout math (shared/git/
//     worktreeLayout.ts) against where the CLI would create a worktree,
//     for every layout.
//   - projects:list is the CLI's list, decorated, a lookup of a project
//     registered behind the host's back resolves after one refresh, and
//     an unknown id is the entity-gone error.
//   - worktrees:list, a mutation's describe, the auto-pull and shelf
//     marks and relocate (marks and notes carried to the new id) all
//     answer with the CLI's rows, and an unknown worktree is the
//     entity-gone error.
//   - projects:reorder, :defaultBranch and :pickWorktreeName, the
//     config reads, the launcher row and catalog, a launch through
//     `sm open` that counts the use, and the package scripts read.
//   - a removal that must happen (a nuke, the rollback of a failed
//     mirror start) runs the teardown through `sm rm`, and a teardown
//     that fails still removes the worktree.
//
// Runs under test/lib/register-ts-alias.mjs. Run: pnpm test cli-reads.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeProof,
  sandboxGit,
  scrubbedGitEnv,
  scrubProcessGitEnv,
  waitFor,
} from "./lib/checkKit.mjs";
import { wireHostCli } from "./lib/smBinary.mjs";
import doubutsuNames from "../../cli/embed/doubutsu-names.json" with { type: "json" };

// The host runs git in this process's environment, so a hook's GIT_*
// variables go before any host module loads.
const gitEnv = scrubbedGitEnv();
scrubProcessGitEnv();
const git = sandboxGit(gitEnv);

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "sm-cli-reads-")));
const dataDir = join(sandbox, "data");
mkdirSync(dataDir);
const { sm } = await wireHostCli(dataDir);

const { worktreeIdFromPath } = await import("@host/lib/git/worktrees");
const { findProjectOrThrow, loadProjects } = await import("@host/lib/projects");
const { readWorktreeData, writeWorktreeData } =
  await import("@host/lib/config/project");
const {
  forceRemoveViaCli,
  globalConfigWriteViaCli,
  listWorktreeIdentitiesViaCli,
  shigomoriWriteViaCli,
  worktreeDestinationViaCli,
} = await import("@host/ipc/cliDelegate");
const { projectsHandlers } = await import("@host/ipc/modules/projects");
const { worktreesHandlers } = await import("@host/ipc/modules/worktrees");
const { launchersHandlers } = await import("@host/ipc/modules/launchers");
const { packageScriptsHandlers } =
  await import("@host/ipc/modules/packageScripts");
const { globalConfigHandlers } = await import("@host/ipc/modules/globalConfig");
const { shigomoriHandlers } = await import("@host/ipc/modules/shigomori");
const { invalidateGlobalConfigCache } = await import("@host/lib/config/global");
const { invalidateProjectConfigCache } =
  await import("@host/lib/config/project");
const { layoutInputsFor, worktreeBaseFor, worktreePathFor } =
  await import("@shared/git/worktreeLayout");

const { check, done, fail } = makeProof("cli-reads proof");

// A repo with one commit at <sandbox>/<name>.
function makeRepo(name) {
  const repo = join(sandbox, name);
  git(sandbox, "init", "-q", "-b", "main", name);
  writeFileSync(join(repo, "readme.txt"), `${name}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

// Registers a repo through the CLI behind the host's back (no refresh
// of its snapshot), answering the CLI's project document.
async function addBehindTheHost(path) {
  const { docs } = await sm("projects", "add", "--", path);
  const project = docs.findLast((doc) => typeof doc.id === "string");
  assert.ok(project, `projects add emitted no project for ${path}`);
  return project;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

async function main() {
  console.log("cli-reads proof\n");

  const repo = makeRepo("alpha");
  // Under the managed root, so the shelf applies to it.
  const managedBase = join(dataDir, "worktrees", "alpha");
  const linkedPath = join(managedBase, "alpha-linked");
  git(repo, "worktree", "add", "-q", "-b", "linked", linkedPath);
  const registered = await projectsHandlers.add({ path: repo });
  const projectId = registered.id;

  await check(
    "ids: worktreeIdFromPath matches the id the CLI prints for every checkout",
    async () => {
      const identities = await listWorktreeIdentitiesViaCli({ projectId });
      assert.deepEqual(
        identities.map((identity) => identity.path),
        [repo, linkedPath],
        "primary first, then the linked worktree",
      );
      for (const identity of identities) {
        assert.equal(identity.id, worktreeIdFromPath(identity.path));
      }
    },
  );

  await check(
    "layout: the renderer's destination math agrees with where the CLI would create, for every layout",
    async (track) => {
      track(() =>
        shigomoriWriteViaCli(projectId, { defaultBranch: "main" }).then(() =>
          invalidateProjectConfigCache(projectId),
        ),
      );
      const custom = join(sandbox, "custom-base");
      for (const config of [
        { defaultBranch: "main" },
        { defaultBranch: "main", worktreeLayout: "in-project" },
        {
          defaultBranch: "main",
          worktreeLayout: "custom",
          customWorktreePath: ` ${custom}/ `,
        },
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one config at a time
        await shigomoriWriteViaCli(projectId, config);
        invalidateProjectConfigCache(projectId);
        // The renderer's inputs come off the same read it makes.
        // oxlint-disable-next-line no-await-in-loop -- see above
        const stored = await shigomoriHandlers.read({ projectId });
        const inputs = layoutInputsFor(stored, repo, dataDir);
        // oxlint-disable-next-line no-await-in-loop -- see above
        const planned = await worktreeDestinationViaCli(projectId, "probe");
        const layout = config.worktreeLayout ?? "managed-root";
        assert.equal(
          worktreePathFor(inputs, "probe"),
          planned.path,
          `${layout}: the preview and the CLI disagree`,
        );
        assert.equal(
          `${worktreeBaseFor(inputs)}/probe`,
          planned.path,
          `${layout}: the base label and the CLI disagree`,
        );
        assert.equal(planned.taken, false);
      }
    },
  );

  await check(
    "projects: the list is the CLI's, a project added behind the host's back resolves after one refresh, and an unknown id is entity-gone",
    async () => {
      const list = await projectsHandlers.list();
      const row = list.find((project) => project.id === projectId);
      assert.ok(row, "the registered project is listed");
      assert.equal(row.path, repo);
      assert.equal(row.pathExists, true);
      assert.match(row.identity ?? "", /^root:[0-9a-f]{40}$/);
      assert.equal(typeof row.lastUsed, "number");
      const beta = makeRepo("beta");
      const behind = await addBehindTheHost(beta);
      assert.equal(
        loadProjects().some((project) => project.id === behind.id),
        false,
        "the snapshot saw an add it wasn't told about",
      );
      assert.equal((await findProjectOrThrow(behind.id)).path, beta);
      assert.ok(loadProjects().some((project) => project.id === behind.id));
      await assert.rejects(
        () => findProjectOrThrow("NOPE"),
        /Unknown project: NOPE/,
      );
      await assert.rejects(
        () => worktreesHandlers.list({ projectId: "NOPE" }),
        /Unknown project: NOPE/,
      );
    },
  );

  await check(
    "rows: worktrees:list and the marks answer with the CLI's rows, and an unknown worktree is entity-gone",
    async () => {
      const rows = await worktreesHandlers.list({ projectId });
      assert.deepEqual(
        rows.map((row) => [row.path, row.isPrimary]),
        [
          [repo, true],
          [linkedPath, false],
        ],
      );
      const linkedId = worktreeIdFromPath(linkedPath);
      const pulled = await worktreesHandlers.setAutoPull({
        projectId,
        worktreeId: linkedId,
        autoPull: true,
      });
      assert.equal(pulled.autoPull, true);
      const shelved = await worktreesHandlers.setShelved({
        projectId,
        worktreeId: linkedId,
        shelved: true,
      });
      assert.equal(shelved.shelved, true);
      assert.equal(shelved.autoPull, true, "the shelf kept the other mark");
      const registry = readJson(join(dataDir, "registry.json"));
      assert.deepEqual(registry.shelvedWorktrees, { [linkedId]: true });
      assert.deepEqual(registry.autoPullWorktrees, { [linkedId]: true });
      await assert.rejects(
        () =>
          worktreesHandlers.setShelved({
            projectId,
            worktreeId: "000000000000",
            shelved: true,
          }),
        /Unknown worktree: 000000000000/,
      );
      await assert.rejects(
        () =>
          worktreesHandlers.commitDiff({
            projectId,
            worktreeId: "000000000000",
            hash: "abcdef1",
          }),
        /Unknown worktree: 000000000000/,
      );
    },
  );

  await check(
    "relocate: the move carries the marks and the notes to the new id, and the primary refuses",
    async () => {
      const oldId = worktreeIdFromPath(linkedPath);
      await writeWorktreeData(projectId, oldId, { notes: "keep me" });
      const destination = join(managedBase, "alpha-moved");
      const moved = await worktreesHandlers.relocate({
        projectId,
        worktreeId: oldId,
        destinationPath: destination,
      });
      assert.equal(moved.path, destination);
      assert.equal(moved.id, worktreeIdFromPath(destination));
      assert.equal(moved.shelved, true);
      assert.equal(moved.autoPull, true);
      assert.equal(existsSync(linkedPath), false);
      assert.deepEqual(await readWorktreeData(projectId, moved.id), {
        notes: "keep me",
      });
      assert.equal(await readWorktreeData(projectId, oldId), null);
      const registry = readJson(join(dataDir, "registry.json"));
      assert.deepEqual(registry.shelvedWorktrees, { [moved.id]: true });
      await assert.rejects(
        () =>
          worktreesHandlers.relocate({
            projectId,
            worktreeId: worktreeIdFromPath(repo),
            destinationPath: join(sandbox, "nowhere"),
          }),
        /primary checkout can't be relocated/,
      );
    },
  );

  await check(
    "projects: reorder, defaultBranch and pickWorktreeName come from the CLI",
    async () => {
      const before = (await projectsHandlers.list()).map((p) => p.id);
      assert.equal(before.length, 2);
      await projectsHandlers.reorder({
        draggedId: before[1],
        targetId: before[0],
        position: "before",
      });
      assert.deepEqual(
        (await projectsHandlers.list()).map((p) => p.id),
        [before[1], before[0]],
      );
      assert.deepEqual(
        readJson(join(dataDir, "registry.json")).projects.map((p) => p.id),
        [before[1], before[0]],
      );
      assert.equal(await projectsHandlers.defaultBranch({ projectId }), "main");
      // A fresh data dir is seeded with Doubutsu names on (cli/state.go
      // seedFreshInstall), so the pick is a villager's name.
      const picked = await projectsHandlers.pickWorktreeName({ projectId });
      assert.ok(doubutsuNames.names.includes(picked), `picked ${picked}`);
    },
  );

  await check(
    "config: globalConfig:read and shigomori:read serve the stored documents, and an unknown project is entity-gone",
    async (track) => {
      track(() =>
        globalConfigWriteViaCli({}).then(invalidateGlobalConfigCache),
      );
      await globalConfigWriteViaCli({ doubutsuNames: true });
      invalidateGlobalConfigCache();
      const global = await globalConfigHandlers.read();
      assert.equal(global.doubutsuNames, true);
      assert.equal(global.deleteBranchOnRemove, undefined, "no defaults");
      assert.equal(
        (await shigomoriHandlers.read({ projectId })).defaultBranch,
        "main",
      );
      await assert.rejects(
        () => shigomoriHandlers.read({ projectId: "NOPE" }),
        /Unknown project: NOPE/,
      );
    },
  );

  await check(
    "launchers: the row and the catalog are the CLI's, and a launch through sm open counts the use",
    async (track) => {
      const marker = join(sandbox, "launched");
      track(() =>
        globalConfigWriteViaCli({}).then(invalidateGlobalConfigCache),
      );
      await globalConfigWriteViaCli({
        launchers: [
          { id: "mark", label: "Mark", command: `touch '${marker}'` },
          { id: "gone", label: "Gone", command: "true" },
        ],
        hiddenLaunchers: ["custom:gone"],
      });
      invalidateGlobalConfigCache();
      const row = await launchersHandlers.forProject({ projectId });
      assert.ok(
        row.entries.some(
          (e) =>
            e.kind === "custom" && e.id === "custom:mark" && e.label === "Mark",
        ),
      );
      assert.equal(
        row.entries.some((e) => e.id === "custom:gone"),
        false,
      );
      assert.ok(row.hiddenCount >= 1);
      const catalog = await launchersHandlers.detect();
      const finder = catalog.find((entry) => entry.id === "app:finder");
      assert.equal(finder?.available, true);
      await launchersHandlers.launch({
        projectId,
        worktreeId: worktreeIdFromPath(repo),
        launcherId: "custom:mark",
      });
      await waitFor(() => existsSync(marker), "the launched command's marker");
      const state = readJson(join(dataDir, "state.json"));
      assert.equal(state.launcherUseLog["custom:mark"].length, 1);
      const reordered = await launchersHandlers.forProject({ projectId });
      assert.equal(reordered.entries[0].id, "custom:mark", "most used first");
    },
  );

  await check(
    "scripts: packageScripts:list reads the manifest in order with the lockfile's manager, and null without a package.json",
    async () => {
      const worktreeId = worktreeIdFromPath(repo);
      assert.equal(
        await packageScriptsHandlers.list({ projectId, worktreeId }),
        null,
      );
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ scripts: { zeta: "echo z", alpha: "echo a" } }),
      );
      writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      const listed = await packageScriptsHandlers.list({
        projectId,
        worktreeId,
      });
      assert.deepEqual(Object.entries(listed.scripts), [
        ["zeta", "echo z"],
        ["alpha", "echo a"],
      ]);
      assert.equal(listed.packageManager, "pnpm");
      assert.deepEqual(listed.usage.zeta, { lastUsed: 0, recentCount: 0 });
      await assert.rejects(
        () =>
          packageScriptsHandlers.list({
            projectId,
            worktreeId: "000000000000",
          }),
        /Unknown worktree: 000000000000/,
      );
    },
  );

  await check(
    "removal: a forced removal runs the teardown through sm rm, and one whose teardown fails still goes",
    async () => {
      const project = await findProjectOrThrow(projectId);
      const tornDown = join(sandbox, "torn-down");
      await shigomoriWriteViaCli(projectId, {
        defaultBranch: "main",
        scripts: { teardown: `touch '${tornDown}'` },
      });
      // Managed ones: an external worktree never had a setup to undo.
      const first = join(managedBase, "alpha-first");
      git(repo, "worktree", "add", "-q", "-b", "first", first);
      await forceRemoveViaCli(project, worktreeIdFromPath(first));
      assert.equal(existsSync(first), false);
      assert.ok(existsSync(tornDown), "the teardown never ran");
      await shigomoriWriteViaCli(projectId, {
        defaultBranch: "main",
        scripts: { teardown: "exit 3" },
      });
      const second = join(managedBase, "alpha-second");
      git(repo, "worktree", "add", "-q", "-b", "second", second);
      writeFileSync(join(second, "dirty.txt"), "uncommitted\n");
      await forceRemoveViaCli(project, worktreeIdFromPath(second));
      assert.equal(existsSync(second), false);
      assert.equal(
        (await listWorktreeIdentitiesViaCli({ projectId })).some(
          (identity) => identity.path === second,
        ),
        false,
      );
    },
  );

  rmSync(sandbox, { recursive: true, force: true });
  done();
}

main().catch(fail);
