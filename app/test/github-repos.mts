// Durable proof for the clone dialog's list of GitHub repositories
// (listGithubRepos): an organization whose SAML the token isn't
// authorized for makes gh exit non-zero with the rest of the list on
// stdout, and those repositories are still offered. A failure with no
// list on stdout stands, in gh's words. Drives the real host code
// against a fake gh on PATH. Run: pnpm test github-repos.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { listGithubRepos } from "@host/lib/githubCli/actions";
import { it } from "vitest";
import { runHost } from "./lib/adapters.mts";
import { tempDir } from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

const track = trackTest;

// What GitHub answers: the list, and the error beside it.
const repos = (names: readonly (string | null)[]) =>
  JSON.stringify({
    data: {
      viewer: {
        repositories: {
          nodes: names.map((n) => (n === null ? null : { nameWithOwner: n })),
        },
      },
    },
    errors: [{ type: "FORBIDDEN", message: "SAML" }],
  });

it("a partial answer's repositories are offered, and a bare failure stands", async () => {
  const root = tempDir("sm-gh-repos-", track);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const answer = join(root, "answer.json");
  const failing = join(root, "failing");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
case "$*" in
"auth status") ;;
"api graphql "*)
  cat '${answer}'
  if [ -e '${failing}' ]; then echo "gh: Resource protected by organization SAML enforcement." >&2; exit 1; fi;;
*) echo "unexpected gh $*" >&2; exit 1;;
esac
`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const path = process.env["PATH"];
  const ghConfig = process.env["GH_CONFIG_DIR"];
  process.env["PATH"] = `${bin}${delimiter}${path ?? ""}`;
  process.env["GH_CONFIG_DIR"] = join(root, "gh-config");
  track(() => {
    process.env["PATH"] = path;
    if (ghConfig === undefined) delete process.env["GH_CONFIG_DIR"];
    else process.env["GH_CONFIG_DIR"] = ghConfig;
  });
  writeFileSync(answer, repos(["me/a", null, "org/b"]));
  writeFileSync(failing, "");
  assert.deepEqual(await runHost(listGithubRepos()), ["me/a", "org/b"]);

  writeFileSync(answer, "");
  await assert.rejects(
    runHost(listGithubRepos()),
    /Resource protected by organization SAML enforcement\./,
  );
});
