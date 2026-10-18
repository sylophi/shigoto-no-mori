// Durable proof that gh's readiness (host/lib/githubCli/GithubCli.ts)
// reads gh's own store, per host gh knows: a machine offline, where
// `gh auth status` fails asking GitHub, and a login to an Enterprise
// host alone, where a bare `gh auth token` answers for github.com, both
// read as signed in.
//
// Run: pnpm test gh-readiness.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { it } from "vitest";
import * as GithubCli from "@host/lib/githubCli/GithubCli";
import { builtNow, runHost } from "./lib/hostRuntime.mts";
import { installFakeGh, tempDir } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

it("gh signed in to an Enterprise host alone, offline, reads as ready", async () => {
  const root = tempDir("sm-gh-ready-", trackTest);
  // Offline: anything asking GitHub fails. Only the Enterprise host's
  // token is in gh's store.
  installFakeGh(
    root,
    `#!/bin/sh
case "$*" in
"auth token --hostname ghe.example.test") echo token ;;
*) echo "error connecting to github.com" >&2; exit 1;;
esac
`,
    trackTest,
  );
  const config = join(root, "gh-config");
  mkdirSync(config);
  writeFileSync(
    join(config, "hosts.yml"),
    "ghe.example.test:\n    user: someone\n    git_protocol: https\n",
  );
  // Built after gh's config is in place, as the host reads where it is
  // as its graph is built.
  const readiness = await runHost(
    Effect.flatMap(GithubCli.GithubCli, (cli) => cli.readiness).pipe(
      Effect.provide(builtNow(GithubCli.layer)),
    ),
  );
  assert.equal(readiness.installed, true);
  assert.equal(readiness.authed, true);
});
