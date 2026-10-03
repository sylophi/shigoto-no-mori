// Durable proof for the scenes (lab/scenes): the app's views drawn from
// the lab's fixtures, which the marketing site renders at build time.
//
// Asserts: every scene renders to HTML in Node, where there is no
// window, no app bridge and no browser. That is the views' contract
// (a view takes its data as props and imports nothing that reads the
// app at load), so a view that starts to reach for a hook, a query or
// window.api, directly or through an import, fails here rather than in
// the marketing build.
//
// Loads the scenes through the lab's Vite config, the way the marketing
// build does, since they are TSX behind the app's aliases.
// Run: pnpm test scenes.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { makeProof } from "./lib/checkKit.mts";

const proof = makeProof("scenes proof");
console.log("scenes proof\n");

assert.equal(
  (globalThis as { window?: unknown }).window,
  undefined,
  "the proof needs a Node without window",
);

const vite = await createServer({
  configFile: fileURLToPath(new URL("../lab/vite.config.ts", import.meta.url)),
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: "custom",
  logLevel: "error",
});
try {
  const { scenes } = (await vite.ssrLoadModule("/scenes/index.ts")) as {
    scenes: Record<string, { Scene: ComponentType }>;
  };
  assert.ok(Object.keys(scenes).length > 0, "no scenes");
  for (const [name, { Scene }] of Object.entries(scenes)) {
    const html = renderToStaticMarkup(createElement(Scene));
    assert.ok(html.length > 0, `${name} rendered nothing`);
    assert.ok(!html.includes("NaN"), `${name} rendered a NaN`);
    proof.ok(`${name} renders without the app`);
  }
  proof.done();
} catch (error) {
  proof.fail(error);
} finally {
  await vite.close();
}
