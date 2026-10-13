// Durable proof for the clone dialog's list of GitHub repositories
// (listGithubRepos): an organization whose SAML the token isn't
// authorized for makes gh exit non-zero with the rest of the list on
// stdout, and those repositories are still offered. A failure with no
// list on stdout stands, in gh's words. Drives the real host code
// against a fake gh on PATH. Run: pnpm test github-repos.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listGithubRepos } from "@host/lib/githubCli/actions";
import { it } from "vitest";
import { runHost } from "./lib/hostRuntime.mts";
import { installFakeGh, tempDir } from "./lib/checkKit.mts";
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
  const answer = join(root, "answer.json");
  const failing = join(root, "failing");
  installFakeGh(
    root,
    `#!/bin/sh
case "$*" in
"auth token"*) ;;
"api graphql "*)
  cat '${answer}'
  if [ -e '${failing}' ]; then echo "gh: Resource protected by organization SAML enforcement." >&2; exit 1; fi;;
*) echo "unexpected gh $*" >&2; exit 1;;
esac
`,
    track,
  );
  writeFileSync(answer, repos(["me/a", null, "org/b"]));
  writeFileSync(failing, "");
  assert.deepEqual(await runHost(listGithubRepos()), ["me/a", "org/b"]);

  writeFileSync(answer, "");
  await assert.rejects(
    runHost(listGithubRepos()),
    /Resource protected by organization SAML enforcement\./,
  );
});
