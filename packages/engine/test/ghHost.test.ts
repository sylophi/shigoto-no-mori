// A repo's gh runs go to its own GitHub host: gh's api goes to
// github.com unless GH_HOST says otherwise, even in a repo on an
// Enterprise host.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, it } from "vitest";
import { ghHostFor, ghKnownHosts } from "../src/ghHost.ts";
import * as GitHub from "../src/GitHub.ts";
import { type Sandbox, sandbox } from "./lib/sandbox.ts";

const HOSTS = "github.com:\n    user: me\nghe.example.com:\n    user: me\n";

describe("ghHostFor", () => {
  const known = ghKnownHosts(HOSTS);
  const host = (...remotes: Array<[string, string]>) =>
    ghHostFor(
      remotes.map(([name, url]) => ({ name, url })),
      known,
    );

  it("reads the host off every remote form", () => {
    assert.equal(
      host(["origin", "git@ghe.example.com:o/r.git"]),
      "ghe.example.com",
    );
    assert.equal(host(["origin", "ghe.example.com:o/r"]), "ghe.example.com");
    assert.equal(
      host(["origin", "https://ghe.example.com/o/r.git"]),
      "ghe.example.com",
    );
    assert.equal(
      host(["origin", "https://me:token@ghe.example.com:8443/o/r"]),
      "ghe.example.com",
    );
    assert.equal(
      host(["origin", "ssh://git@GHE.Example.com:22/o/r.git"]),
      "ghe.example.com",
    );
    // The SSH-over-443 alias is the host's own.
    assert.equal(host(["origin", "git@ssh.github.com:o/r.git"]), "github.com");
    assert.equal(
      host(["origin", "ssh://git@ssh.ghe.example.com:443/o/r.git"]),
      "ghe.example.com",
    );
  });

  it("takes gh's own choice of remote: upstream, github, origin, then the first", () => {
    const github = "git@github.com:o/r.git";
    const ghe = "git@ghe.example.com:o/r.git";
    assert.equal(host(["backup", github], ["origin", ghe]), "ghe.example.com");
    assert.equal(host(["origin", ghe], ["github", github]), "github.com");
    assert.equal(
      host(["github", github], ["upstream", ghe]),
      "ghe.example.com",
    );
    assert.equal(host(["a", ghe], ["b", github]), "ghe.example.com");
    // A remote's push URL is not where gh reads it from.
    assert.equal(host(["origin", "/tmp/r"], ["origin", ghe]), null);
  });

  it("leaves gh's own choice where no remote is on a host it knows", () => {
    assert.equal(host(["origin", "https://git.example.com/o/r.git"]), null);
    assert.equal(host(["origin", "/srv/git/r.git"]), null);
    assert.equal(host(), null);
    // github.com counts without a hosts.yml.
    assert.equal(
      ghHostFor(
        [{ name: "origin", url: "git@github.com:o/r" }],
        ghKnownHosts(""),
      ),
      "github.com",
    );
  });
});

describe("GitHub.run", () => {
  let box: Sandbox;
  let ghHost: string | undefined;
  beforeEach(() => {
    ghHost = process.env.GH_HOST;
    delete process.env.GH_HOST;
  });
  afterEach(async () => {
    if (ghHost !== undefined) process.env.GH_HOST = ghHost;
    await box.remove();
  });

  // The fake gh answers only when GH_HOST names the Enterprise host,
  // as github.com would know no such repo. A mirror on github.com,
  // listed first, doesn't take origin's place.
  it("reads a repo's merge settings from its own host", async () => {
    box = sandbox();
    const config = join(box.home, ".config", "gh");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "hosts.yml"), HOSTS);
    box.fakeBin(
      "gh",
      `case "$GH_HOST $*" in
  "ghe.example.com api graphql "*) echo '{"data":{"repository":{"mergeCommitAllowed":false,"squashMergeAllowed":true,"rebaseMergeAllowed":false,"autoMergeAllowed":true}}}';;
  *) echo "gh: Could not resolve to a Repository (HTTP 404)" >&2; exit 1;;
esac`,
    );
    const repo = box.repo("repo");
    box.git(repo, "remote", "add", "origin", "git@ghe.example.com:o/r.git");
    box.git(repo, "remote", "add", "backup", "git@github.com:o/r.git");
    assert.deepEqual(
      await box.engine(
        Effect.flatMap(GitHub.GitHub, (github) => github.mergeSettings(repo)),
      ),
      { allowed: ["squash"], autoMerge: true },
    );

    // A host gh isn't signed in to leaves gh's own choice.
    box.git(repo, "remote", "remove", "backup");
    box.git(
      repo,
      "remote",
      "set-url",
      "origin",
      "https://git.example.com/o/r.git",
    );
    assert.equal(
      await box.engine(
        Effect.flatMap(GitHub.GitHub, (github) => github.hostOf(repo)),
      ),
      null,
    );
  });
});
