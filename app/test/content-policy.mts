// Durable proof for the window's Content-Security-Policy
// (main/electron/contentPolicy.ts): a packaged build runs the bundle
// and Clerk's script alone, with no inline script or eval, connects to
// the loopback and Clerk alone, and shows images from GitHub and Clerk
// alone (a remote's come as data: URLs, projects:remoteImage), as the
// web client's static policy (vercel.json) does; Clerk's host is the
// one its key names; and the page has no inline script a
// policy without an inline allowance would block (the vite-bundled
// module aside).
//
// Run: pnpm test content-policy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import * as Schema from "effect/Schema";
import { GITHUB_IMAGE_HOSTS } from "@shigomori/contracts/predicates/imageHosts";
import {
  clerkFrontendHost,
  rendererContentPolicy,
} from "../main/electron/contentPolicy";

const directives = (policy: string) =>
  new Map(
    policy.split("; ").map((directive) => {
      const [name = "", ...sources] = directive.split(" ");
      return [name, sources] as const;
    }),
  );

const keyFor = (host: string) =>
  `pk_live_${Buffer.from(`${host}$`).toString("base64")}`;

it("names the Clerk host its publishable key encodes, and none for a key that isn't one", () => {
  assert.equal(
    clerkFrontendHost(keyFor("clerk.example.com")),
    "clerk.example.com",
  );
  assert.equal(clerkFrontendHost(""), null);
  assert.equal(clerkFrontendHost("pk_live_bm90IGEgaG9zdA=="), null);
  assert.equal(clerkFrontendHost(keyFor("evil.com; script-src *")), null);
});

it("a packaged build runs no inline script or eval, connects to the loopback and Clerk alone, and shows images from GitHub and Clerk alone, a remote's coming as data: URLs", () => {
  const policy = directives(
    rendererContentPolicy({ clerkHost: "clerk.example.com", dev: false }),
  );
  assert.deepEqual(policy.get("default-src"), ["'self'"]);
  const scripts = policy.get("script-src") ?? [];
  assert.ok(scripts.includes("https://clerk.example.com"));
  assert.ok(!scripts.some((source) => source.startsWith("'unsafe")));
  assert.deepEqual(policy.get("connect-src"), [
    "'self'",
    "ws://127.0.0.1:*",
    "https://clerk.example.com",
    "https://challenges.cloudflare.com",
  ]);
  // Images from GitHub and Clerk's avatars alone, as in the web client:
  // one on a project's remote's host comes as a data: URL.
  assert.deepEqual(policy.get("img-src"), [
    "'self'",
    "data:",
    "blob:",
    "https://img.clerk.com",
    "https://github.com",
    "https://*.github.com",
    "https://githubusercontent.com",
    "https://*.githubusercontent.com",
  ]);
  assert.deepEqual(policy.get("media-src"), ["'self'", "data:"]);
  assert.deepEqual(policy.get("object-src"), ["'none'"]);
  assert.deepEqual(policy.get("frame-ancestors"), ["'none'"]);
});

it("the web client's policy shows images from the remote hosts a window's does, GitHub's each with its subdomains", () => {
  const Vercel = Schema.fromJsonString(
    Schema.Struct({
      headers: Schema.Array(
        Schema.Struct({
          headers: Schema.Array(
            Schema.Struct({ key: Schema.String, value: Schema.String }),
          ),
        }),
      ),
    }),
  );
  const vercel = Schema.decodeUnknownSync(Vercel)(
    readFileSync(join(import.meta.dirname, "..", "vercel.json"), "utf8"),
  );
  const web = vercel.headers
    .flatMap((rule) => rule.headers)
    .find((header) => header.key === "Content-Security-Policy");
  assert.ok(web !== undefined, "vercel.json sends a policy");
  const remote = (policy: string) =>
    new Set(
      directives(policy)
        .get("img-src")
        ?.filter((source) => source.startsWith("https://")),
    );
  const desktop = remote(
    rendererContentPolicy({ clerkHost: null, dev: false }),
  );
  assert.deepEqual(remote(web.value), desktop);
  for (const host of GITHUB_IMAGE_HOSTS) {
    assert.ok(desktop.has(`https://${host}`));
    assert.ok(desktop.has(`https://*.${host}`));
  }
});

it("the page has no classic inline script", () => {
  const page = readFileSync(
    join(import.meta.dirname, "..", "index.html"),
    "utf8",
  );
  const inline = [
    ...page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g),
  ].filter(
    ([, attributes = "", body = ""]) =>
      !attributes.includes("src=") &&
      !attributes.includes('type="module"') &&
      body.trim() !== "",
  );
  assert.deepEqual(inline, []);
});
