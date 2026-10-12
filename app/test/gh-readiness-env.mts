// Durable proof that gh's readiness (host/lib/githubCli/GithubCli.ts)
// asks gh's own default host too: a login through GH_HOST and a token
// in the environment, with nothing in gh's file, offline, reads as
// signed in. (A file of its own, since the readiness is cached for the
// host's life; gh-readiness.mts has the Enterprise login in the file.)
//
// Run: pnpm test gh-readiness-env.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import * as Effect from "effect/Effect";
import { it } from "vitest";
import { GithubCli } from "@host/lib/githubCli/GithubCli";
import { runHost } from "./lib/hostRuntime.mts";
import { tempDir } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

it("gh signed in through GH_HOST and a token in the environment alone, offline, reads as ready", async () => {
  const root = tempDir("sm-gh-ready-", trackTest);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // Offline: anything asking GitHub fails. Only the Enterprise host's
  // token is in gh's store.
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
case "$*" in
"auth token") [ "$GH_HOST" = ghe.example.test ] && [ -n "$GH_ENTERPRISE_TOKEN" ] && echo token || exit 1 ;;
*) echo "error connecting to github.com" >&2; exit 1;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const config = join(root, "gh-config");
  mkdirSync(config);
  // Nothing in gh's file: the login is the environment's.
  const path = process.env["PATH"];
  const ghConfig = process.env["GH_CONFIG_DIR"];
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  process.env["GH_CONFIG_DIR"] = config;
  process.env["GH_HOST"] = "ghe.example.test";
  process.env["GH_ENTERPRISE_TOKEN"] = "from-the-environment";
  trackTest(() => {
    delete process.env["GH_HOST"];
    delete process.env["GH_ENTERPRISE_TOKEN"];
    process.env["PATH"] = path;
    if (ghConfig === undefined) delete process.env["GH_CONFIG_DIR"];
    else process.env["GH_CONFIG_DIR"] = ghConfig;
  });
  const readiness = await runHost(
    Effect.flatMap(GithubCli, (cli) => cli.readiness),
  );
  assert.equal(readiness.installed, true);
  assert.equal(readiness.authed, true);
});
