// Durable proof for the host reading the data model through the CLI
// (host/ipc/cliDelegate.ts): the REAL sm binary built from cli/
// (test/lib/smBinary.mts) answers the REAL IPC handlers against real
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
//     marks and relocate (marks and the title carried to the new id) all
//     answer with the CLI's rows, and an unknown worktree is the
//     entity-gone error.
//   - hygiene:diskUsage measures through `sm disk-usage`, and a file
//     hard-linked in from outside counts on disk but not as reclaimable.
//   - projects:reorder, :defaultBranch and :pickWorktreeName, the
//     config reads, the CLI's config keys and defaults against the
//     schemas' (DEVICE_SETTINGS_DEFAULTS, PROJECT_CONFIG_DEFAULTS), a
//     device setting saved back to its default leaving the file, keys
//     this build doesn't model surviving a settings save, the
//     launcher row and catalog, a launch through
//     `sm open` that counts the use, and the package scripts read.
//   - a removal that must happen (a nuke, the rollback of a failed
//     mirror start) runs the teardown through `sm rm`, and a teardown
//     that fails still removes the worktree.
//   - worktrees:convertExternal unforced refuses a worktree whose only
//     change is an untracked file `status.showUntrackedFiles no` hides
//     from its row, with the refusal the convert page matches
//     (isConvertRefusedError), and so one whose status can't be read.
//     Forced it converts, and so with no force field, as a renderer
//     from before the field expects.
//
// Runs under test/lib/register-ts-alias.mts. Run: pnpm test cli-reads.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handlerCtx,
  makeProof,
  sandboxGit,
  scrubbedGitEnv,
  scrubProcessGitEnv,
  waitFor,
} from "./lib/checkKit.mts";
import { addProject, wireHostCli } from "./lib/smBinary.mts";
import type { DoctorReport } from "@shared/ipc/modules/cli";
import type { ShigomoriConfig } from "@shared/schemas/config";
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
const { readWorktreeData, writeWorktreeData, writeWorktreeDescription } =
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
const { hygieneHandlers } = await import("@host/ipc/modules/hygiene");
const { cliHandlers, setCliImpl } = await import("@host/ipc/modules/cli");
const { invalidateGlobalConfigCache } = await import("@host/lib/config/global");
const { invalidateProjectConfigCache } =
  await import("@host/lib/config/project");
const { layoutInputsFor, worktreeBaseFor, worktreePathFor } =
  await import("@shared/git/worktreeLayout");
const { readRegistry } = await import("./lib/cliSandbox.mts");
const { isConvertRefusedError } = await import("@shared/errors");
const {
  DEVICE_SETTINGS_DEFAULTS,
  modeledKeyPaths,
  PROJECT_CONFIG_DEFAULTS,
  ShigomoriConfigSchema,
} = await import("@shared/schemas/config");

const { check, done, fail } = makeProof("cli-reads proof");

// What the handlers get from the wire. None of the ones driven here
// streams back or cares who called.
const ctx = handlerCtx();

// The part of state.json the checks read back.
type StateFile = { launcherUseLog: Record<string, number[]> };

// The Electron-only CLI calls the doctor check never reaches.
const notDriven = () =>
  Promise.reject(new Error("not driven by the cli-reads proof"));

// A repo with one commit at <sandbox>/<name>.
function makeRepo(name: string) {
  const repo = join(sandbox, name);
  git(sandbox, "init", "-q", "-b", "main", name);
  writeFileSync(join(repo, "readme.txt"), `${name}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

// A config list's entry (cli/cmd_config.go configListEntry).
type ConfigListEntry = { key: string; value: unknown; set: boolean };
const settingsOf = ({ docs }: { docs: Record<string, unknown>[] }) =>
  (docs.at(-1)?.["settings"] ?? []) as ConfigListEntry[];

// A config list against the app's side: the same keys, each unset and
// reading as its default (null for a key with none). `skip` names a key
// the list can't show unset (the required defaultBranch).
function assertListedDefaults(
  label: string,
  entries: ConfigListEntry[],
  keys: string[],
  defaults: Record<string, unknown>,
  skip?: string,
) {
  assert.deepEqual(
    entries.map((entry) => entry.key).toSorted(),
    keys.toSorted(),
    `${label}: the CLI's keys and the app's disagree`,
  );
  for (const entry of entries) {
    if (entry.key === skip) continue;
    assert.equal(entry.set, false, `${label}: ${entry.key} is still stored`);
    assert.deepEqual(
      entry.value,
      defaults[entry.key] ?? null,
      `${label}: ${entry.key}'s default in the CLI and the app disagree`,
    );
  }
}

// A doctor report's findings for one check id.
const findingsOf = (report: DoctorReport, id: string) =>
  report.checks.filter((finding) => finding.id === id);

async function main() {
  console.log("cli-reads proof\n");

  const repo = makeRepo("alpha");
  // Under the managed root, so the shelf applies to it.
  const managedBase = join(dataDir, "worktrees", "alpha");
  const linkedPath = join(managedBase, "alpha-linked");
  git(repo, "worktree", "add", "-q", "-b", "linked", linkedPath);
  const registered = await projectsHandlers.add({ path: repo }, ctx);
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
    "disk usage: a file linked in from outside counts on disk, not as reclaimable",
    async () => {
      // pnpm's hard-link import, in miniature: the store keeps the
      // blocks after the worktree is gone.
      const size = 64 * 1024;
      const store = join(sandbox, "store.bin");
      const linked = join(linkedPath, "linked.bin");
      writeFileSync(store, randomBytes(size));
      linkSync(store, linked);
      try {
        const worktreeId = worktreeIdFromPath(linkedPath);
        const usage = await hygieneHandlers.diskUsage(
          { projectId, worktreeId },
          ctx,
        );
        assert.equal(usage.worktreeId, worktreeId);
        assert.equal(usage.partial, false);
        assert.ok(
          usage.bytes - usage.reclaimableBytes >= size,
          `${usage.bytes} on disk, ${usage.reclaimableBytes} reclaimable`,
        );
        assert.ok(usage.reclaimableBytes > 0, "the checkout's own files");
        assert.equal(typeof usage.lastActivityAt, "number");
      } finally {
        rmSync(linked);
        rmSync(store);
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
      const configs: ShigomoriConfig[] = [
        { defaultBranch: "main" },
        { defaultBranch: "main", worktreeLayout: "in-project" },
        {
          defaultBranch: "main",
          worktreeLayout: "custom",
          customWorktreePath: ` ${custom}/ `,
        },
      ];
      for (const config of configs) {
        // oxlint-disable-next-line no-await-in-loop -- one config at a time
        await shigomoriWriteViaCli(projectId, config);
        invalidateProjectConfigCache(projectId);
        // The renderer's inputs come off the same read it makes.
        // oxlint-disable-next-line no-await-in-loop -- see above
        const stored = await shigomoriHandlers.read({ projectId }, ctx);
        const inputs = layoutInputsFor(stored, repo, {
          dataDir,
          canonicalDataDirName: ".smd",
          onProjectDrive: false,
        });
        // oxlint-disable-next-line no-await-in-loop -- see above
        const planned = await worktreeDestinationViaCli(projectId, "probe");
        const layout =
          config.worktreeLayout ?? PROJECT_CONFIG_DEFAULTS.worktreeLayout;
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
      // The device's managedOnProjectDrive setting, on. This repo sits
      // on no external drive, so both sides stay under the data dir.
      // The write is the whole document, so the fresh install's seed
      // rides along and is put back after.
      const seeded = await globalConfigHandlers.read(undefined, ctx);
      track(() =>
        globalConfigWriteViaCli(seeded).then(invalidateGlobalConfigCache),
      );
      await globalConfigWriteViaCli({ ...seeded, managedOnProjectDrive: true });
      invalidateGlobalConfigCache();
      const settings = await globalConfigHandlers.read(undefined, ctx);
      assert.equal(settings.managedOnProjectDrive, true);
      await shigomoriWriteViaCli(projectId, { defaultBranch: "main" });
      invalidateProjectConfigCache(projectId);
      const planned = await worktreeDestinationViaCli(projectId, "probe");
      assert.equal(
        worktreePathFor(
          layoutInputsFor(null, repo, {
            dataDir,
            canonicalDataDirName: ".smd",
            onProjectDrive: true,
          }),
          "probe",
        ),
        planned.path,
        "setting on, internal project: the preview and the CLI disagree",
      );
      // A repo on an external drive can't be staged in a sandbox, so
      // the drive rule is pinned by value here and, spelled the same,
      // in cli/paths_test.go. The drive's folder takes the flavor's
      // name, which a data dir moved or named otherwise doesn't change.
      const onDrive = (
        projectPath: string,
        dir: string,
        {
          worktreeLayout = PROJECT_CONFIG_DEFAULTS.worktreeLayout,
          onProjectDrive = true,
        }: Pick<ShigomoriConfig, "worktreeLayout"> & {
          onProjectDrive?: boolean;
        } = {},
      ) =>
        worktreeBaseFor(
          layoutInputsFor({ worktreeLayout }, projectPath, {
            dataDir: dir,
            canonicalDataDirName: ".sm",
            onProjectDrive,
          }),
        );
      assert.equal(
        onDrive("/Volumes/Ext/code/repo", "/Users/me/.sm"),
        "/Volumes/Ext/.sm/worktrees/repo",
      );
      assert.equal(
        onDrive("/Volumes/Ext/code/repo", "/Users/me/.sm", {
          onProjectDrive: false,
        }),
        "/Users/me/.sm/worktrees/repo",
        "setting off: under the data dir",
      );
      assert.equal(
        onDrive("/Users/me/code/repo", "/Users/me/.sm"),
        "/Users/me/.sm/worktrees/repo",
        "a project on the internal drive stays under the data dir",
      );
      assert.equal(
        onDrive("/Volumes/Ext/code/repo", "/Volumes/Ext/stash/.sm"),
        "/Volumes/Ext/stash/.sm/worktrees/repo",
        "a data dir on the project's drive is already there",
      );
      assert.equal(
        onDrive("/Volumes/Ext/code/repo", "/Volumes/Other/data"),
        "/Volumes/Ext/.sm/worktrees/repo",
      );
      assert.equal(
        onDrive("/Volumes/Ext/code/repo", "/Users/me/.sm", {
          worktreeLayout: "in-project",
        }),
        "/Volumes/Ext/code/repo/.shigomori/worktrees",
        "the setting belongs to the managed layout",
      );
    },
  );

  await check(
    "projects: the list is the CLI's, a project added behind the host's back resolves after one refresh, and an unknown id is entity-gone",
    async () => {
      const list = await projectsHandlers.list(undefined, ctx);
      const row = list.find((project) => project.id === projectId);
      assert.ok(row, "the registered project is listed");
      assert.equal(row.path, repo);
      assert.equal(row.pathExists, true);
      assert.match(row.identity ?? "", /^root:[0-9a-f]{40}$/);
      assert.equal(typeof row.lastUsed, "number");
      const beta = makeRepo("beta");
      // Through the CLI behind the host's back: no refresh of its
      // snapshot.
      const behind = await addProject(sm, beta);
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
        async () => worktreesHandlers.list({ projectId: "NOPE" }, ctx),
        /Unknown project: NOPE/,
      );
    },
  );

  await check(
    "rows: worktrees:list and the marks answer with the CLI's rows, and an unknown worktree is entity-gone",
    async () => {
      const rows = await worktreesHandlers.list({ projectId }, ctx);
      assert.deepEqual(
        rows.map((row) => [row.path, row.isPrimary]),
        [
          [repo, true],
          [linkedPath, false],
        ],
      );
      const linkedId = worktreeIdFromPath(linkedPath);
      const pulled = await worktreesHandlers.setAutoPull(
        {
          projectId,
          worktreeId: linkedId,
          autoPull: true,
        },
        ctx,
      );
      assert.equal(pulled.autoPull, true);
      const shelved = await worktreesHandlers.setShelved(
        {
          projectId,
          worktreeId: linkedId,
          shelved: true,
        },
        ctx,
      );
      assert.equal(shelved.shelved, true);
      assert.equal(shelved.autoPull, true, "the shelf kept the other mark");
      const registry = readRegistry(dataDir);
      assert.deepEqual(registry.shelvedWorktrees, { [linkedId]: true });
      assert.deepEqual(registry.autoPullWorktrees, { [linkedId]: true });
      await assert.rejects(
        async () =>
          worktreesHandlers.setShelved(
            {
              projectId,
              worktreeId: "000000000000",
              shelved: true,
            },
            ctx,
          ),
        /Unknown worktree: 000000000000/,
      );
      await assert.rejects(
        async () =>
          worktreesHandlers.commitDiff(
            {
              projectId,
              worktreeId: "000000000000",
              hash: "abcdef1",
            },
            ctx,
          ),
        /Unknown worktree: 000000000000/,
      );
    },
  );

  await check(
    "relocate: the move carries the marks and the title to the new id, and the primary refuses",
    async () => {
      const oldId = worktreeIdFromPath(linkedPath);
      await writeWorktreeDescription(projectId, oldId, {
        title: "keep me",
        describedAt: 1,
      });
      // The renderer's write (the ports) keeps the title on disk.
      await writeWorktreeData(projectId, oldId, { ports: [{ port: 4100 }] });
      const destination = join(managedBase, "alpha-moved");
      const moved = await worktreesHandlers.relocate(
        {
          projectId,
          worktreeId: oldId,
          destinationPath: destination,
        },
        ctx,
      );
      assert.equal(moved.path, destination);
      assert.equal(moved.id, worktreeIdFromPath(destination));
      assert.equal(moved.shelved, true);
      assert.equal(moved.autoPull, true);
      assert.equal(existsSync(linkedPath), false);
      assert.equal(moved.title, "keep me");
      assert.deepEqual(await readWorktreeData(projectId, moved.id), {
        title: "keep me",
        describedAt: 1,
        ports: [{ port: 4100 }],
      });
      assert.equal(await readWorktreeData(projectId, oldId), null);
      const registry = readRegistry(dataDir);
      assert.deepEqual(registry.shelvedWorktrees, { [moved.id]: true });
      await assert.rejects(
        async () =>
          worktreesHandlers.relocate(
            {
              projectId,
              worktreeId: worktreeIdFromPath(repo),
              destinationPath: join(sandbox, "nowhere"),
            },
            ctx,
          ),
        /primary checkout can't be relocated/,
      );
    },
  );

  await check(
    "projects: reorder, defaultBranch and pickWorktreeName come from the CLI",
    async () => {
      const before = (await projectsHandlers.list(undefined, ctx)).map(
        (p) => p.id,
      );
      assert.equal(before.length, 2);
      const [firstId, secondId] = before;
      assert.ok(firstId !== undefined && secondId !== undefined);
      await projectsHandlers.reorder(
        {
          draggedId: secondId,
          targetId: firstId,
          position: "before",
        },
        ctx,
      );
      assert.deepEqual(
        (await projectsHandlers.list(undefined, ctx)).map((p) => p.id),
        [secondId, firstId],
      );
      // Stored apart from the entries, which stay in the order added.
      const registry = readRegistry(dataDir);
      assert.deepEqual(
        registry.projectOrder,
        [before[1], before[0]].map(
          (id) => registry.projects.find((p) => p.id === id)?.path,
        ),
      );
      assert.deepEqual(
        registry.projects.map((p) => p.id),
        before,
      );
      assert.equal(
        await projectsHandlers.defaultBranch({ projectId }, ctx),
        "main",
      );
      // A fresh data dir is seeded with Doubutsu names on (cli/state.go
      // seedFreshInstall), so the pick is a villager's name.
      const picked = await projectsHandlers.pickWorktreeName(
        { projectId },
        ctx,
      );
      assert.ok(doubutsuNames.names.includes(picked), `picked ${picked}`);
    },
  );

  await check(
    "projects: relocate points a project moved by hand at its new path and keeps its id",
    async (track) => {
      const gamma = makeRepo("gamma");
      const added = await projectsHandlers.add({ path: gamma }, ctx);
      track(() => projectsHandlers.remove({ id: added.id }, ctx));
      const moved = join(sandbox, "gamma-moved");
      renameSync(gamma, moved);
      const missing = (await projectsHandlers.list(undefined, ctx)).find(
        (p) => p.id === added.id,
      );
      assert.equal(missing?.pathExists, false);
      const relocated = await projectsHandlers.relocate(
        { id: added.id, path: moved },
        ctx,
      );
      assert.equal(relocated.id, added.id);
      assert.equal(relocated.path, moved);
      assert.equal(relocated.name, "gamma-moved");
      const row = (await projectsHandlers.list(undefined, ctx)).find(
        (p) => p.id === added.id,
      );
      assert.equal(row?.path, moved);
      assert.equal(row.pathExists, true);
      assert.equal((await findProjectOrThrow(added.id)).path, moved);
      await assert.rejects(
        async () =>
          projectsHandlers.relocate({ id: added.id, path: sandbox }, ctx),
        /not a git repository/,
      );
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
      const global = await globalConfigHandlers.read(undefined, ctx);
      assert.equal(global.doubutsuNames, true);
      assert.equal(global.deleteBranchOnRemove, undefined, "no defaults");
      assert.equal(
        (await shigomoriHandlers.read({ projectId }, ctx))?.defaultBranch,
        "main",
      );
      await assert.rejects(
        async () => shigomoriHandlers.read({ projectId: "NOPE" }, ctx),
        /Unknown project: NOPE/,
      );
    },
  );

  await check(
    "config keys: sm config and sm projects config list the schemas' keys with their defaults",
    async (track) => {
      // The parity below leaves no modeled key the CLI doesn't register,
      // so clearing one by null is cli/cmd_config_test.go's
      // TestConfigWriteNullClearsUnregisteredKeys.

      // Everything back to absent, so the lists show each default.
      const reset = () =>
        Promise.all([
          globalConfigWriteViaCli({}).then(invalidateGlobalConfigCache),
          shigomoriWriteViaCli(projectId, { defaultBranch: "main" }).then(() =>
            invalidateProjectConfigCache(projectId),
          ),
        ]);
      track(reset);
      await reset();
      const [deviceList, projectList] = await Promise.all([
        sm("config", "list"),
        sm("projects", "config", "list", "--project-id", projectId),
      ]);

      // The device settings the form manages are the CLI's registry,
      // key for key. directConnections and cloudflaredPath are
      // config-only and stay out of both.
      assertListedDefaults(
        "sm config",
        settingsOf(deviceList),
        Object.keys(DEVICE_SETTINGS_DEFAULTS),
        DEVICE_SETTINGS_DEFAULTS,
      );
      // Every project setting the schema models is in the registry.
      assertListedDefaults(
        "sm projects config",
        settingsOf(projectList),
        modeledKeyPaths(ShigomoriConfigSchema.shape).map((path) =>
          path.join("."),
        ),
        PROJECT_CONFIG_DEFAULTS,
        "defaultBranch",
      );

      // A registered device setting saved back to its default leaves
      // the file.
      const configPath = join(dataDir, "config.json");
      const save = (patch: { portPool: boolean }) =>
        globalConfigHandlers.writeDeviceSettings({ patch }, ctx);
      await save({ portPool: true });
      assert.equal(readJson(configPath).portPool, true);
      await save({ portPool: false });
      assert.equal("portPool" in readJson(configPath), false);

      // Keys this build doesn't model ride through a save untouched, a
      // null and an object of nulls included: only the managed settings
      // go in the payload.
      const before = readFileSync(configPath, "utf8");
      track(() => {
        writeFileSync(configPath, before);
        invalidateGlobalConfigCache();
      });
      writeFileSync(
        configPath,
        JSON.stringify({
          ...JSON.parse(before),
          futureKey: null,
          futureObj: { a: null },
        }),
      );
      await save({ portPool: true });
      const saved = readJson(configPath);
      assert.equal(saved.portPool, true);
      assert.equal(saved.futureKey, null);
      assert.deepEqual(saved.futureObj, { a: null });
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
      const row = await launchersHandlers.forProject({ projectId }, ctx);
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
      const catalog = await launchersHandlers.detect(undefined, ctx);
      const finder = catalog.find((entry) => entry.id === "app:finder");
      assert.equal(finder?.available, true);
      await launchersHandlers.launch(
        {
          projectId,
          worktreeId: worktreeIdFromPath(repo),
          launcherId: "custom:mark",
        },
        ctx,
      );
      await waitFor(() => existsSync(marker), "the launched command's marker");
      const state: StateFile = readJson(join(dataDir, "state.json"));
      assert.equal(state.launcherUseLog["custom:mark"]?.length, 1);
      const reordered = await launchersHandlers.forProject({ projectId }, ctx);
      assert.equal(reordered.entries[0]?.id, "custom:mark", "most used first");
    },
  );

  await check(
    "scripts: packageScripts:list reads the manifest in order with the lockfile's manager, and null without a package.json",
    async () => {
      const worktreeId = worktreeIdFromPath(repo);
      assert.equal(
        await packageScriptsHandlers.list({ projectId, worktreeId }, ctx),
        null,
      );
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ scripts: { zeta: "echo z", alpha: "echo a" } }),
      );
      writeFileSync(join(repo, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      const listed = await packageScriptsHandlers.list(
        {
          projectId,
          worktreeId,
        },
        ctx,
      );
      assert.ok(listed, "a package.json is there now");
      assert.deepEqual(Object.entries(listed.scripts), [
        ["zeta", "echo z"],
        ["alpha", "echo a"],
      ]);
      assert.equal(listed.packageManager, "pnpm");
      assert.deepEqual(listed.usage.zeta, { lastUsed: 0, recentCount: 0 });
      await assert.rejects(
        async () =>
          packageScriptsHandlers.list(
            {
              projectId,
              worktreeId: "000000000000",
            },
            ctx,
          ),
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

  await check(
    "convert: a worktree whose only change is an untracked file the setting hides is refused unforced and untouched, and so is an unreadable status, and it converts forced or with no force field",
    async () => {
      git(repo, "config", "status.showUntrackedFiles", "no");
      try {
        // An external checkout whose only change is a file its row
        // can't count.
        const external = (name: string) => {
          const path = join(sandbox, `alpha-${name}`);
          git(repo, "worktree", "add", "-q", "-b", name, path);
          writeFileSync(join(path, "notes.txt"), "only copy\n");
          return { path, worktreeId: worktreeIdFromPath(path) };
        };
        const outside = external("outside");
        const row = (await worktreesHandlers.list({ projectId }, ctx)).find(
          (w) => w.id === outside.worktreeId,
        );
        assert.equal(row?.isExternal, true);
        assert.equal(row.changedCount, 0, "the row should honor the setting");
        await assert.rejects(
          async () =>
            worktreesHandlers.convertExternal(
              { projectId, worktreeId: outside.worktreeId, force: false },
              ctx,
            ),
          isConvertRefusedError,
          "an unforced convert should refuse the untracked file",
        );
        assert.equal(
          readFileSync(join(outside.path, "notes.txt"), "utf8"),
          "only copy\n",
        );
        const forced = await worktreesHandlers.convertExternal(
          { projectId, worktreeId: outside.worktreeId, force: true },
          ctx,
        );
        assert.equal(forced.worktree.isExternal, false);
        assert.equal(existsSync(outside.path), false);

        // No field is what a renderer from before it sends: forced.
        const legacy = external("legacy");
        const converted = await worktreesHandlers.convertExternal(
          { projectId, worktreeId: legacy.worktreeId },
          ctx,
        );
        assert.equal(converted.worktree.isExternal, false);
        assert.equal(existsSync(legacy.path), false);

        // A status that can't be read is refused the same way, so the
        // page asks instead of leaving the row stuck.
        const broken = join(sandbox, "alpha-broken");
        git(repo, "worktree", "add", "-q", "-b", "broken", broken);
        const pointer = readFileSync(join(broken, ".git"), "utf8");
        writeFileSync(join(broken, ".git"), "gitdir: /nowhere\n");
        await assert.rejects(
          async () =>
            worktreesHandlers.convertExternal(
              {
                projectId,
                worktreeId: worktreeIdFromPath(broken),
                force: false,
              },
              ctx,
            ),
          isConvertRefusedError,
          "an unreadable status should refuse like a dirty one",
        );
        writeFileSync(join(broken, ".git"), pointer);
        git(repo, "worktree", "remove", "--force", broken);
      } finally {
        git(repo, "config", "--unset", "status.showUntrackedFiles");
      }
    },
  );

  await check(
    "doctor: a failed check still answers the report, and repair applies only what it marks repairable",
    async () => {
      // The Electron side overlays the login shell's rc locations, and the
      // sandbox has no shell hook to find either way.
      setCliImpl({
        cliLinkStatus: notDriven,
        installCliLinks: notDriven,
        uninstallCliEverything: notDriven,
        shellIntegrationStatus: notDriven,
        installShellIntegration: notDriven,
        uninstallShellIntegration: notDriven,
        hookPathEnv: async () => ({}),
      });
      const goneRepo = makeRepo("gone");
      const gone = await addProject(sm, goneRepo);
      rmSync(goneRepo, { recursive: true, force: true });
      const dormantId = "0123ABCD-0000-0000-0000-000000000000";
      mkdirSync(join(dataDir, "projects", dormantId), { recursive: true });

      const report = await cliHandlers.doctor(undefined, ctx);
      assert.ok(report.summary.fail > 0, "a project whose path is gone fails");
      const [pathGone] = findingsOf(report, "project-path");
      assert.equal(pathGone?.title, "gone");
      assert.equal(pathGone.status, "fail");
      assert.equal(pathGone.repairable, true);
      const [dormant] = findingsOf(report, "dormant-state");
      assert.equal(dormant?.status, "warn");
      assert.ok(dormant.detail.includes(dormantId), dormant.detail);
      assert.equal(dormant.repairable, undefined);

      const fixed = await cliHandlers.doctorFix(undefined, ctx);
      assert.deepEqual(fixed.repaired, ["unregistered gone"]);
      assert.deepEqual(fixed.repairFailed, []);
      assert.equal(findingsOf(fixed, "project-path").length, 0);
      assert.equal(findingsOf(fixed, "dormant-state").length, 1);
      assert.ok(existsSync(join(dataDir, "projects", dormantId)));
      assert.equal(
        loadProjects().some((project) => project.id === gone.id),
        false,
        "the host's snapshot still lists the unregistered project",
      );
      assert.ok(loadProjects().some((project) => project.id === projectId));
    },
  );

  rmSync(sandbox, { recursive: true, force: true });
  done();
}

main().catch(fail);
