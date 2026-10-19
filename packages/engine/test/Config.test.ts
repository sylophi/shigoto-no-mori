import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DeviceSettingsPatchSchema,
  modeledKeyPaths,
  ShigomoriConfigSchema,
} from "@shigomori/contracts/schemas/config";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Config from "../src/Config.ts";
import * as Registry from "../src/Registry.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const config = Effect.service(Config.Config);

// The keys come from the schemas, so a setting the app models is one the
// engine lists, reads and clears, with nothing else to keep in step.
it("models exactly the schemas' keys", async () => {
  const listed = (scope: Config.ConfigScope) =>
    box.engine(
      config.pipe(
        Effect.flatMap((c) => c.list(scope)),
        Effect.map((settings) => settings.map(({ key }) => key).toSorted()),
      ),
    );
  assert.deepEqual(
    await listed({ kind: "device" }),
    Object.keys(DeviceSettingsPatchSchema.struct.fields).toSorted(),
  );
  assert.deepEqual(
    await listed({ kind: "project", projectId: "P", path: "/nowhere" }),
    modeledKeyPaths(ShigomoriConfigSchema)
      .map((path) => path.join("."))
      .toSorted(),
  );
});

it("points a list key at its own verbs, or at the file and the app", async () => {
  const setList = (key: string) =>
    box.engine(
      config.pipe(Effect.flatMap((c) => c.set({ kind: "device" }, key, "x"))),
    );
  assert.deepEqual(await setList("launchers"), {
    ok: false,
    error: "launchers is structured: use `smd config launcher add/rm`.",
  });
  assert.deepEqual(await setList("hiddenLaunchers"), {
    ok: false,
    error: "hiddenLaunchers is structured: use `smd config edit` or the app.",
  });
});

it("keeps a project's default branch through every write", async () => {
  const project = {
    kind: "project",
    projectId: "P",
    path: "/nowhere",
  } as const;
  assert.deepEqual(
    await box.engine(
      config.pipe(Effect.flatMap((c) => c.set(project, "portBase", "4000"))),
    ),
    {
      ok: false,
      error:
        "Can't determine P's default branch. Set it first: smd projects config set defaultBranch <ref> -p P",
    },
  );
});

it("takes an absolute custom path, home-expanded and cleaned, and refuses a relative one", async () => {
  box.write("projects/P/project.json", { defaultBranch: "main" });
  const project = {
    kind: "project",
    projectId: "P",
    path: "/nowhere",
  } as const;
  const set = (raw: string) =>
    box.engine(
      config.pipe(
        Effect.flatMap((c) => c.set(project, "customWorktreePath", raw)),
      ),
    );
  assert.equal(await set("~/trees/./x/"), `${box.home}/trees/x`);
  assert.deepEqual(await set("trees"), {
    ok: false,
    error: "customWorktreePath must be an absolute path.",
  });
});

it("hides .shigomori from the primary's git status on the in-project layout", async () => {
  const repo = box.repo("repo");
  const project = { kind: "project", projectId: "P", path: repo } as const;
  assert.equal(
    await box.engine(
      config.pipe(
        Effect.flatMap((c) => c.set(project, "worktreeLayout", "in-project")),
      ),
    ),
    "in-project",
  );
  const set = (await box.engine(
    config.pipe(Effect.flatMap((c) => c.read(project))),
  )) as Record<string, unknown>;
  assert.deepEqual(set, {
    defaultBranch: "main",
    worktreeLayout: "in-project",
  });
  assert.match(
    readFileSync(join(repo, ".git", "info", "exclude"), "utf8"),
    /^\/\.shigomori$/m,
  );
});

// The app's save is a patch in one transaction: a setting the terminal
// wrote meanwhile, which the form didn't touch, stays.
it("patches the device's settings it is given and keeps the rest, a default or a null removing its key", async () => {
  type Doc = Record<string, unknown> | null;
  const stored = (await box.engine(
    Effect.gen(function* () {
      const c = yield* config;
      const base = yield* c.read({ kind: "device" });
      yield* c.set({ kind: "device" }, "portPool", "true");
      yield* c.patch({ terrier: true, editor: "zed", githubCli: true });
      const first = yield* c.read({ kind: "device" });
      yield* c.patch({
        terrier: false,
        editor: null,
        launchScripts: undefined,
      });
      return { base, first, after: yield* c.read({ kind: "device" }) };
    }),
  )) as { readonly base: Doc; readonly first: Doc; readonly after: Doc };
  assert.deepEqual(stored.first, {
    ...stored.base,
    portPool: true,
    terrier: true,
    editor: "zed",
  });
  assert.deepEqual(stored.after, { ...stored.base, portPool: true });
});

it("refuses a patch whose value isn't the setting's, writing nothing", async () => {
  const exit = (await box.engine(
    Effect.gen(function* () {
      const c = yield* config;
      const base = yield* c.read({ kind: "device" });
      const refused = yield* Effect.flip(
        c.patch({
          terrier: true,
          launchers: [{ id: "", label: "x", command: "y" }],
        }),
      );
      return { base, refused, stored: yield* c.read({ kind: "device" }) };
    }),
  )) as {
    readonly base: unknown;
    readonly refused: unknown;
    readonly stored: unknown;
  };
  assert.ok(exit.refused instanceof Config.InvalidConfigDocument);
  assert.deepEqual(exit.stored, exit.base);
});

it("patches the project's settings it is given and keeps what changed elsewhere, a null removing its key", async () => {
  const repo = box.repo("proj");
  const stored = (await box.engine(
    Effect.gen(function* () {
      const c = yield* config;
      const project = yield* (yield* Registry.Registry).register({
        name: "proj",
        path: repo,
      });
      const scope = {
        kind: "project",
        projectId: project.id,
        path: repo,
      } as const;
      yield* c.set(scope, "defaultBranch", "main");
      yield* c.set(scope, "scripts.teardown", "make clean");
      // The form saves its two fields; the terminal sets another after
      // the form read; the form's next save clears one of its own.
      yield* c.patchProject(scope, {
        "scripts.setup": "pnpm install",
        showPrimaryInInbox: true,
      });
      yield* c.set(scope, "portBase", "4000");
      yield* c.patchProject(scope, { "scripts.teardown": null });
      const refused = yield* Effect.flip(
        c.patchProject(scope, { defaultBranch: " " }),
      );
      return { refused, doc: yield* c.read(scope) };
    }),
  )) as { readonly refused: unknown; readonly doc: unknown };
  assert.ok(stored.refused instanceof Config.InvalidConfigDocument);
  assert.deepEqual(stored.doc, {
    defaultBranch: "main",
    scripts: { setup: "pnpm install" },
    showPrimaryInInbox: true,
    portBase: 4000,
  });
});

it("patches a project with no stored settings, git naming its default branch and the in-project layout excluded", async () => {
  const repo = box.repo("bare-proj");
  const stored = await box.engine(
    Effect.gen(function* () {
      const c = yield* config;
      const project = yield* (yield* Registry.Registry).register({
        name: "bare-proj",
        path: repo,
      });
      const scope = {
        kind: "project",
        projectId: project.id,
        path: repo,
      } as const;
      yield* c.patchProject(scope, { worktreeLayout: "in-project" });
      return yield* c.read(scope);
    }),
  );
  assert.deepEqual(stored, {
    defaultBranch: "main",
    worktreeLayout: "in-project",
  });
  assert.match(
    readFileSync(join(repo, ".git/info/exclude"), "utf8"),
    /^\/\.shigomori$/m,
  );
});

// A setting read as it applies, by a key the compiler checks: unset or
// holding something it can't be, its default.
it("reads a device setting as it applies, its default when unset or unreadable", async () => {
  const read = await box.engine(
    Effect.gen(function* () {
      const c = yield* config;
      const unset = yield* c.device("deleteBranchOnRemove");
      yield* c.change({ kind: "device" }, () => ({
        deleteBranchOnRemove: "yes",
        portPool: true,
      }));
      return {
        unset,
        unreadable: yield* c.device("deleteBranchOnRemove"),
        set: yield* c.device("portPool"),
        editor: yield* c.device("editor"),
      };
    }),
  );
  assert.deepEqual(read, {
    unset: true,
    unreadable: true,
    set: true,
    editor: null,
  });
});

it("writes nothing for a change that answers none: no default branch filled in, nothing excluded", async () => {
  const repo = box.repo("untouched");
  const stored = await box.engine(
    Effect.gen(function* () {
      const c = yield* config;
      const project = yield* (yield* Registry.Registry).register({
        name: "untouched",
        path: repo,
      });
      const scope = {
        kind: "project",
        projectId: project.id,
        path: repo,
      } as const;
      yield* c.change(scope, () => null);
      return yield* c.read(scope);
    }),
  );
  assert.equal(stored, null, "a change that answered none wrote");
});

it("writes over the settings as they were read, and refuses once they changed meanwhile, writing nothing", async () => {
  const race = Effect.gen(function* () {
    const c = yield* config;
    const scope = { kind: "device" } as const;
    const read = (yield* c.read(scope)) ?? {};
    yield* c.write(scope, { ...read, deleteBranchOnRemove: false }, read);
    const afterFirst = (yield* c.read(scope)) ?? {};
    // Another save lands between this read and its write.
    yield* c.set(scope, "autoPullNew", "true");
    const refused = yield* Effect.flip(
      c.write(scope, { ...afterFirst, githubCli: false }, afterFirst),
    );
    return {
      afterFirst,
      refused: refused instanceof Config.ConfigChangedMeanwhile,
      now: yield* c.read(scope),
    };
  });
  const outcome = (await box.engine(race)) as Effect.Success<typeof race>;
  assert.equal(outcome.afterFirst["deleteBranchOnRemove"], false);
  assert.equal(outcome.refused, true, "a write over a stale read went");
  assert.deepEqual(
    outcome.now,
    { ...outcome.afterFirst, autoPullNew: true },
    "the refused write wrote",
  );
});
