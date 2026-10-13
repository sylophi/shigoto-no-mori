// Durable proof that gh's readiness (host/lib/githubCli/GithubCli.ts)
// asks gh's own default host too: a login through GH_HOST and a token
// in the environment, with nothing in gh's file, offline, reads as
// signed in. (A file of its own, since the readiness is cached for the
// host's life; gh-readiness.mts has the Enterprise login in the file.)
//
// Run: pnpm test gh-readiness-env.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { it } from "vitest";
import { GithubCli } from "@host/lib/githubCli/GithubCli";
import { runHost } from "./lib/hostRuntime.mts";
import { installFakeGh, tempDir } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

it("gh signed in through GH_HOST and a token in the environment alone, offline, reads as ready", async () => {
  const root = tempDir("sm-gh-ready-", trackTest);
  // Offline: anything asking GitHub fails. Only the Enterprise host's
  // token is in gh's store.
  installFakeGh(
    root,
    `#!/bin/sh
case "$*" in
"auth token") [ "$GH_HOST" = ghe.example.test ] && [ -n "$GH_ENTERPRISE_TOKEN" ] && echo token || exit 1 ;;
*) echo "error connecting to github.com" >&2; exit 1;;
esac
`,
    trackTest,
  );
  const config = join(root, "gh-config");
  mkdirSync(config);
  // Nothing in gh's file: the login is the environment's.
  process.env["GH_HOST"] = "ghe.example.test";
  process.env["GH_ENTERPRISE_TOKEN"] = "from-the-environment";
  trackTest(() => {
    delete process.env["GH_HOST"];
    delete process.env["GH_ENTERPRISE_TOKEN"];
  });
  const readiness = await runHost(
    Effect.flatMap(GithubCli, (cli) => cli.readiness),
  );
  assert.equal(readiness.installed, true);
  assert.equal(readiness.authed, true);
});
