import assert from "node:assert/strict";
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

const registry = Effect.service(Registry.Registry);
const run = <A, E>(
  program: (registry: Registry.Registry["Service"]) => Effect.Effect<A, E>,
) => box.engine(Effect.flatMap(registry, program));

const project = (id: string, path = `/r/${id}`) => ({ id, name: id, path });

it("registers in order under an uppercase id, refusing a path twice", async () => {
  const added = (await run((r) =>
    Effect.all([
      r.register({ name: "a", path: "/r/a" }),
      r.register({ name: "b", path: "/r/b" }),
    ]),
  )) as Registry.RegisteredProject[];
  for (const { id } of added) {
    assert.match(id, /^[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$/);
  }
  assert.deepEqual(await run((r) => r.projects), added);
  assert.deepEqual(await run((r) => r.register({ name: "a", path: "/r/a" })), {
    ok: false,
    error: "Project already added: /r/a",
  });
});

it("forgets a project's settings with it", async () => {
  box.write("registry.json", { projects: [project("A")] });
  box.write("projects/A/project.json", { defaultBranch: "main" });
  assert.deepEqual(await run((r) => r.unregister("A")), project("A"));
  assert.equal(
    await box.engine(
      Effect.flatMap(Effect.service(Config.Config), (config) =>
        config.read({ kind: "project", projectId: "A", path: "/r/A" }),
      ),
    ),
    null,
  );
  assert.deepEqual(await run((r) => r.unregister("A")), {
    ok: false,
    error: "Unknown project: A",
  });
});

it("orders by the stored paths, then the rest as listed", () => {
  const listed = [project("a"), project("b"), project("c")];
  assert.deepEqual(
    Registry.orderProjects(listed, ["/r/c", "/r/x", "/r/a", "/r/c"]).map(
      (p) => p.id,
    ),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    Registry.keepUnlisted(["/r/b", "/r/a"], ["/r/x", "/r/a", "/r/y", "/r/b"]),
    ["/r/x", "/r/b", "/r/a", "/r/y"],
  );
});

it("stores a reorder whole, keeping paths it doesn't list in place", async () => {
  box.write("registry.json", { projectOrder: ["/r/gone", "/r/b"] });
  const listed = [project("a"), project("b"), project("c")];
  assert.equal(await run((r) => r.reorder(listed, ["c", "stale"])), true);
  assert.deepEqual(await run((r) => r.order), [
    "/r/gone",
    "/r/c",
    "/r/a",
    "/r/b",
  ]);
  assert.equal(await run((r) => r.reorder(listed, ["a"])), false);
});

it("marks worktrees, carries the marks on a move and drops the snapshot", async () => {
  const marks = await run((r) =>
    Effect.gen(function* () {
      yield* r.setMark("shelved", "old", true);
      yield* r.setMark("autoPull", "old", true);
      yield* r.setShelfSnapshot("old", { at: 1, head: null, changed: 0 });
      yield* r.moveWorktree("old", "new");
      yield* r.setMark("autoPull", "other", true);
      yield* r.forgetWorktree("other");
      return [
        [...(yield* r.marked("shelved"))],
        [...(yield* r.marked("autoPull"))],
        [...(yield* r.shelfSnapshots).keys()],
      ];
    }),
  );
  assert.deepEqual(marks, [["new"], ["new"], []]);
});

it("starts a shelf from a fresh snapshot", async () => {
  const snapshots = await run((r) =>
    Effect.gen(function* () {
      yield* r.setShelfSnapshot("w", { at: 1, head: "abc", changed: 2 });
      yield* r.setMark("shelved", "w", true);
      return (yield* r.shelfSnapshots).size;
    }),
  );
  assert.equal(snapshots, 0);
});

it("keeps a device id once minted, and replaces one that isn't UUID-shaped", async () => {
  box.write("registry.json", { deviceId: "not-a-uuid" });
  const [first, second] = (await run((r) =>
    Effect.all([r.deviceId, r.deviceId]),
  )) as [string, string];
  assert.match(first, /^[0-9a-f]{8}-/);
  assert.equal(second, first);
});
