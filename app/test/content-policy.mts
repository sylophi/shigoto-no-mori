// Durable proof for the window's Content-Security-Policy
// (main/electron/contentPolicy.ts): a packaged build runs the bundle
// and Clerk's script alone, with no inline script or eval, connects to
// the loopback and Clerk alone, and shows images from GitHub, Clerk and
// the remotes' hosts alone; Clerk's host is the one its key
// names; and the page has no inline script a policy without an inline
// allowance would block (the vite-bundled module aside).
//
// Run: pnpm test content-policy.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
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

it("a packaged build runs no inline script or eval, connects to the loopback and Clerk alone, and shows images from GitHub, Clerk and the remotes' hosts alone", () => {
  const policy = directives(
    rendererContentPolicy({
      clerkHost: "clerk.example.com",
      dev: false,
      imageHosts: ["git.uni.example"],
    }),
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
  // Images from GitHub, Clerk's avatars and the remotes' hosts alone.
  assert.deepEqual(policy.get("img-src"), [
    "'self'",
    "data:",
    "blob:",
    "https://img.clerk.com",
    "https://github.com",
    "https://*.github.com",
    "https://githubusercontent.com",
    "https://*.githubusercontent.com",
    "https://git.uni.example",
    "https://*.git.uni.example",
  ]);
  assert.deepEqual(policy.get("object-src"), ["'none'"]);
  assert.deepEqual(policy.get("frame-ancestors"), ["'none'"]);
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
