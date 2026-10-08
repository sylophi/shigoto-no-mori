import assert from "node:assert/strict";
import {
  DeviceSettingsPatchSchema,
  modeledKeyPaths,
  ShigomoriConfigSchema,
} from "@shigomori/contracts/schemas/config";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, it } from "vitest";
import * as Config from "../src/Config.ts";
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
    await listed({ kind: "project", projectId: "P" }),
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
    error: "launchers is structured: use `sm config launcher add/rm`.",
  });
  assert.deepEqual(await setList("hiddenLaunchers"), {
    ok: false,
    error: "hiddenLaunchers is structured: use `sm config edit` or the app.",
  });
});

it("keeps a project's default branch through every write", async () => {
  const project = { kind: "project", projectId: "P" } as const;
  assert.deepEqual(
    await box.engine(
      config.pipe(Effect.flatMap((c) => c.set(project, "portBase", "4000"))),
    ),
    {
      ok: false,
      error:
        "Set the project's default branch first: `sm projects config set defaultBranch <ref>`.",
    },
  );
});

it("takes an absolute custom path, home-expanded and cleaned, and refuses a relative one", async () => {
  box.write("projects/P/project.json", { defaultBranch: "main" });
  const project = { kind: "project", projectId: "P" } as const;
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
