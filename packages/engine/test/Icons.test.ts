import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, beforeEach, it } from "vitest";
import * as Icons from "../src/Icons.ts";
import * as Registry from "../src/Registry.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

let box: Sandbox;
beforeEach(() => {
  box = sandbox();
});
afterEach(() => box.remove());

const iconOf = (path: string, rescanMisses = false) =>
  box.engine(
    Effect.service(Icons.Icons).pipe(
      Effect.flatMap((icons) => icons.of(path, { rescanMisses })),
      Effect.map(Option.getOrNull),
    ),
  );

it("remembers a project without an icon until asked to look again", async () => {
  const repo = box.repo("repo");
  assert.equal(await iconOf(repo), null);
  mkdirSync(join(repo, "public"));
  writeFileSync(join(repo, "public", "favicon.png"), "png");
  assert.equal(await iconOf(repo), null);
  assert.deepEqual(await iconOf(repo, true), {
    path: join(repo, "public", "favicon.png"),
    mime: "image/png",
  });
});

it("looks again when the remembered icon is gone", async () => {
  const repo = box.repo("repo", {
    "favicon.svg": "<svg/>",
    "assets/icon.png": "png",
  });
  assert.equal(
    ((await iconOf(repo)) as { path: string }).path,
    join(repo, "favicon.svg"),
  );
  rmSync(join(repo, "favicon.svg"));
  assert.equal(
    ((await iconOf(repo)) as { path: string }).path,
    join(repo, "assets", "icon.png"),
  );
});

it("forgets a removed project's remembered miss, so a re-add looks again", async () => {
  const repo = box.repo("repo");
  box.write("registry.json", {
    projects: [{ id: "A", name: "a", path: repo }],
  });
  const icons = () =>
    box.engine(
      Effect.service(Registry.Registry).pipe(
        Effect.flatMap((registry) => registry.rows()),
        Effect.map((rows) => rows.map(({ icon }) => icon?.path ?? null)),
      ),
    );
  assert.deepEqual(await icons(), [null]);
  writeFileSync(join(repo, "favicon.png"), "png");
  assert.deepEqual(await icons(), [null]);
  await box.engine(
    Effect.service(Registry.Registry).pipe(
      Effect.flatMap((registry) =>
        Effect.andThen(
          registry.unregister("A"),
          registry.register({ name: "a", path: repo }),
        ),
      ),
    ),
  );
  assert.deepEqual(await icons(), [join(repo, "favicon.png")]);
});

it("finds each project's icon: conventional files, package roots, icon links", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#e33"/></svg>';
  const atRoot = box.repo("at-root", { "public/favicon.svg": svg });
  const inPackage = box.repo("in-package", {
    "package.json": "{}",
    "web/package.json": "{}",
    "web/assets/icon.svg": svg,
  });
  const linked = box.repo("linked", {
    "index.html": '<link rel="icon" href="/brand/mark.svg?v=2">',
    "public/brand/mark.svg": svg,
  });
  const ignored = box.repo("ignored", {
    ".gitignore": "dist\n",
    "dist/favicon.svg": svg,
  });
  const none = box.repo("none");
  box.write("registry.json", {
    projects: [atRoot, inPackage, linked, ignored, none].map((path, index) => ({
      id: `P${index}`,
      name: `p${index}`,
      path,
    })),
  });
  const rows = (await box.engine(
    Effect.flatMap(Effect.service(Registry.Registry), (r) => r.rows()),
  )) as {
    icon: { path: string } | null;
  }[];
  assert.deepEqual(
    rows.map(({ icon }) => icon?.path.slice(box.home.length) ?? null),
    [
      "/at-root/public/favicon.svg",
      "/in-package/web/assets/icon.svg",
      "/linked/public/brand/mark.svg",
      null,
      null,
    ],
  );
  assert.ok(
    Option.isSome(
      (await box.engine(
        Effect.flatMap(Effect.service(Icons.Icons), (icons) =>
          icons.bytes(linked),
        ),
      )) as Option.Option<unknown>,
    ),
  );
});
