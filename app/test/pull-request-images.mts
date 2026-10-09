// Durable proof that a PR body's attached images load in a private
// repo. An attachment (github.com/user-attachments/assets/<id>) loads
// only for a browser signed in to GitHub, so the host's single-branch
// read (getWorktreePullRequest) points each image in the markdown at
// the signed URL of the body GitHub renders, and leaves a link to one
// as written. A refetch within the signed URL's life keeps the body as
// it was, so the page doesn't load its images again.
//
// Drives the real host code against a fake gh on PATH, whose GraphQL
// answer the proof rewrites between reads to sign the URLs anew. Runs
// under test/lib/register-ts-alias.mts. Run: pnpm test
// pull-request-images.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { setCliRunnerImpl } from "@host/ipc/cliDelegate";
import { getWorktreePullRequest } from "@host/lib/githubCli/pullRequests";
import {
  cliFailureMessage,
  makeProof,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";

const proof = makeProof("pull-request-images proof");
console.log("pull-request-images proof\n");

const PNG = "11111111-1111-4111-8111-111111111111";
const TAG = "22222222-2222-4222-8222-222222222222";
const VIDEO = "33333333-3333-4333-8333-333333333333";
const UNSIGNED = "44444444-4444-4444-8444-444444444444";
const LEGACY = "55555555-5555-4555-8555-555555555555";
const attachment = (id: string) =>
  `https://github.com/user-attachments/assets/${id}`;
const signed = (id: string, ext: string, jwt: string) =>
  `https://private-user-images.githubusercontent.com/1/2-${id}.${ext}?jwt=${jwt}`;

const body = [
  `[![screenshot](${attachment(PNG)})](${attachment(PNG)})`,
  `<img width="300" alt="tag" src="${attachment(TAG)}" />`,
  `<img src=${attachment(PNG)}>`,
  attachment(VIDEO),
  `![gone](${attachment(UNSIGNED)})`,
  `![old](https://github.com/o/r/assets/7/${LEGACY})`,
].join("\n\n");

const row = {
  number: 3,
  url: "https://github.com/o/r/pull/3",
  title: "Pictures",
  body,
  state: "OPEN",
  isDraft: false,
  headRefName: "pics",
  baseRefName: "main",
  isCrossRepository: false,
  mergeStateStatus: "CLEAN",
  autoMergeRequest: null,
  author: { login: "me" },
  updatedAt: "2026-10-01T00:00:00Z",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  statusCheckRollup: [],
};

// GitHub's rendering: an image wrapped in a link, both signed, and a
// bare attachment that is a video. The ampersand comes escaped.
const graphql = (jwt: string) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 3,
              bodyHTML: [
                `<a href="${signed(PNG, "png", jwt)}"><img src="${signed(PNG, "png", jwt)}" alt="screenshot"></a>`,
                `<img src="${signed(TAG, "png", `${jwt}&amp;v=1`)}" alt="tag">`,
                `<video src="${signed(VIDEO, "mp4", jwt)}"></video>`,
                `<img src="${signed(LEGACY, "png", jwt)}" alt="old">`,
              ].join("\n"),
              author: { login: "me" },
              reviewDecision: null,
              latestOpinionatedReviews: { nodes: [] },
              latestReviews: { nodes: [] },
              reviewRequests: { nodes: [] },
            },
          ],
        },
      },
    },
  });

try {
  scrubProcessGitEnv();
  await proof.check(
    "an attached image takes its signed URL, and keeps it",
    async (track) => {
      const root = tempDir("sm-pr-images-", track);
      const bin = join(root, "bin");
      mkdirSync(bin);
      const answer = join(root, "graphql.json");
      const list = join(root, "list.json");
      writeFileSync(list, JSON.stringify([row]));
      writeFileSync(
        join(bin, "gh"),
        `#!/bin/sh
case "$*" in
  "auth status") ;;
  "api graphql "*) cat '${answer}';;
  "pr list --state all --head pics "*) cat '${list}';;
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
      // The integration toggle is read through `sm config read`.
      setCliRunnerImpl({
        runCli: () =>
          Promise.resolve({
            code: 0,
            docs: [{ ok: true, config: {} }],
            stderrTail: "",
          }),
        requireCliBinary: () => "sm",
        cliFailureMessage,
      });
      const repo = join(root, "repo");
      mkdirSync(repo);
      const git = sandboxGit();
      git(repo, "init", "-q");
      git(repo, "remote", "add", "origin", "https://github.com/o/r.git");

      const signedBody = (jwt: string) =>
        [
          `[![screenshot](${signed(PNG, "png", jwt)})](${attachment(PNG)})`,
          `<img width="300" alt="tag" src="${signed(TAG, "png", `${jwt}&v=1`)}" />`,
          `<img src=${signed(PNG, "png", jwt)}>`,
          attachment(VIDEO),
          `![gone](${attachment(UNSIGNED)})`,
          `![old](${signed(LEGACY, "png", jwt)})`,
        ].join("\n\n");

      writeFileSync(answer, graphql("first"));
      assert.equal(
        (await getWorktreePullRequest(repo, "pics"))?.body,
        signedBody("first"),
        "images signed, links and an unsigned image as written",
      );

      writeFileSync(answer, graphql("second"));
      assert.equal(
        (await getWorktreePullRequest(repo, "pics"))?.body,
        signedBody("first"),
        "a refetch keeps the signed URLs",
      );

      // Four minutes on, a URL has a minute left, and the next read
      // takes the newly signed one.
      const now = Date.now;
      Date.now = () => now() + 4 * 60_000;
      track(() => {
        Date.now = now;
      });
      writeFileSync(answer, graphql("third"));
      assert.equal(
        (await getWorktreePullRequest(repo, "pics"))?.body,
        signedBody("third"),
        "a URL near its expiry is signed anew",
      );
    },
  );

  proof.done();
} catch (error) {
  proof.fail(error);
}
