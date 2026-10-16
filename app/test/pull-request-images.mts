// Durable proof that a PR body's attached images load in a private
// repo, on github.com and on a GitHub Enterprise Server in private mode.
// An attachment (<host>/user-attachments/assets/<id>) loads only for a
// browser signed in to its host, so the host's single-branch read
// (getWorktreePullRequest) points each image in the markdown at the URL
// of the body GitHub renders, on the attachment's host, a subdomain of
// it or githubusercontent.com, and leaves a link to one as written. A
// refetch within the signed URL's life keeps the body as it was, so the
// page doesn't load its images again.
//
// Drives the real host code against a fake gh on PATH, which answers
// each repo only when GH_HOST names its host, and whose GraphQL answer
// the proof rewrites between reads to sign the URLs anew. A stand-in
// Enterprise Server (HTTPS on the loopback, a certificate of its own)
// sends an attachment to its sign-in page and serves the media host's
// signed URL, as github.ubc.ca does. Run: pnpm test pull-request-images.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo } from "node:net";
import https from "node:https";
import { join } from "node:path";
import * as PullRequests from "@host/lib/githubCli/pullRequests";
import { runHost } from "./lib/hostRuntime.mts";
import { afterAll, it } from "vitest";
import {
  installFakeGh,
  makeTracker,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";

const getWorktreePullRequest = (cwd: string, branch: string) =>
  runHost(PullRequests.getWorktreePullRequest(cwd, branch));

const tracker = makeTracker();
afterAll(() => tracker.teardown());
scrubProcessGitEnv();
const root = tempDir("sm-pr-images-", tracker.track);
const answers = (host: string) => ({
  list: join(root, `${host}-list.json`),
  graphql: join(root, `${host}-graphql.json`),
});
const GHE = "ghe.example.com";
installFakeGh(
  root,
  `#!/bin/sh
case "$GH_HOST $*" in
*" auth token"*) ;;
"github.com api graphql "*) cat '${answers("github.com").graphql}';;
"github.com pr list --state all --head pics "*) cat '${answers("github.com").list}';;
"${GHE} api graphql "*) cat '${answers(GHE).graphql}';;
"${GHE} pr list --state all --head harper/gold-display "*) cat '${answers(GHE).list}';;
*) echo "unexpected gh $*" >&2; exit 1;;
esac
`,
  tracker.track,
);
mkdirSync(join(root, "gh-config"));
writeFileSync(
  join(root, "gh-config", "hosts.yml"),
  `github.com:\n    user: me\n${GHE}:\n    user: me\n`,
);
const ghHost = process.env["GH_HOST"];
delete process.env["GH_HOST"];
tracker.track(() => {
  if (ghHost !== undefined) process.env["GH_HOST"] = ghHost;
});

const git = sandboxGit();
function repoOn(name: string, remote: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "remote", "add", "origin", remote);
  return repo;
}

const pullRequest = (url: string, branch: string, body: string) => ({
  number: 3,
  url,
  title: "Pictures",
  body,
  state: "OPEN",
  isDraft: false,
  headRefName: branch,
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
});

const graphql = (bodyHTML: string) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 3,
              bodyHTML,
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

const PNG = "11111111-1111-4111-8111-111111111111";
const TAG = "22222222-2222-4222-8222-222222222222";
const VIDEO = "33333333-3333-4333-8333-333333333333";
const UNSIGNED = "44444444-4444-4444-8444-444444444444";
const LEGACY = "55555555-5555-4555-8555-555555555555";

const attachment = (id: string) =>
  `https://github.com/user-attachments/assets/${id}`;
const signed = (id: string, ext: string, jwt: string) =>
  `https://private-user-images.githubusercontent.com/1/2-${id}.${ext}?jwt=${jwt}`;

it("an attached image on github.com takes its signed URL, and keeps it", async () => {
  const body = [
    `[![screenshot](${attachment(PNG)})](${attachment(PNG)})`,
    `<img width="300" alt="tag" src="${attachment(TAG)}" />`,
    `<img src=${attachment(PNG)}>`,
    attachment(VIDEO),
    `![gone](${attachment(UNSIGNED)})`,
    `![old](https://github.com/o/r/assets/7/${LEGACY})`,
  ].join("\n\n");
  // GitHub's rendering: an image wrapped in a link, both signed, and a
  // bare attachment that is a video. The ampersand comes escaped.
  const rendered = (jwt: string) =>
    graphql(
      [
        `<a href="${signed(PNG, "png", jwt)}"><img src="${signed(PNG, "png", jwt)}" alt="screenshot"></a>`,
        `<img src="${signed(TAG, "png", `${jwt}&amp;v=1`)}" alt="tag">`,
        `<video src="${signed(VIDEO, "mp4", jwt)}"></video>`,
        `<img src="${signed(LEGACY, "png", jwt)}" alt="old">`,
      ].join("\n"),
    );
  const { list, graphql: answer } = answers("github.com");
  writeFileSync(
    list,
    JSON.stringify([
      pullRequest("https://github.com/o/r/pull/3", "pics", body),
    ]),
  );
  const repo = repoOn("repo", "https://github.com/o/r.git");

  const signedBody = (jwt: string) =>
    [
      `[![screenshot](${signed(PNG, "png", jwt)})](${attachment(PNG)})`,
      `<img width="300" alt="tag" src="${signed(TAG, "png", `${jwt}&v=1`)}" />`,
      `<img src=${signed(PNG, "png", jwt)}>`,
      attachment(VIDEO),
      `![gone](${attachment(UNSIGNED)})`,
      `![old](${signed(LEGACY, "png", jwt)})`,
    ].join("\n\n");

  writeFileSync(answer, rendered("first"));
  assert.equal(
    (await getWorktreePullRequest(repo, "pics"))?.body,
    signedBody("first"),
    "images signed, links and an unsigned image as written",
  );

  writeFileSync(answer, rendered("second"));
  assert.equal(
    (await getWorktreePullRequest(repo, "pics"))?.body,
    signedBody("first"),
    "a refetch keeps the signed URLs",
  );

  // Four minutes on, a URL has a minute left, and the next read
  // takes the newly signed one.
  const now = Date.now;
  Date.now = () => now() + 4 * 60_000;
  try {
    writeFileSync(answer, rendered("third"));
    assert.equal(
      (await getWorktreePullRequest(repo, "pics"))?.body,
      signedBody("third"),
      "a URL near its expiry is signed anew",
    );
  } finally {
    Date.now = now;
  }
});

// The stand-in Enterprise Server, with subdomain isolation: the
// attachment's own URL sends a browser without a session to sign in,
// and only the media host's URL with its token serves the image.
const IMAGE = Buffer.from("not really a png");
function standIn(): Promise<{
  load: (url: string) => Promise<{ status: number; type?: string }>;
}> {
  const dir = join(root, "tls");
  mkdirSync(dir);
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      `/CN=${GHE}`,
      "-addext",
      `subjectAltName=DNS:${GHE},DNS:*.${GHE}`,
    ],
    { stdio: "ignore" },
  );
  const ca = readFileSync(cert);
  const server = https.createServer(
    { key: readFileSync(key), cert: ca },
    (request, response) => {
      const host = request.headers.host ?? "";
      const url = new URL(request.url ?? "/", `https://${host}`);
      if (host === GHE && url.pathname.includes("/assets/")) {
        response.writeHead(302, { location: `https://${GHE}/login` });
      } else if (
        host === `media.${GHE}` &&
        url.pathname.startsWith("/user/7/files/") &&
        url.searchParams.get("token") === "signed"
      ) {
        response.writeHead(200, { "content-type": "image/png" });
        response.write(IMAGE);
      } else {
        response.writeHead(404);
      }
      response.end();
    },
  );
  tracker.track(() => {
    server.close();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        load: (target) =>
          new Promise((done, fail) => {
            const url = new URL(target);
            https
              .get(
                {
                  host: url.hostname,
                  port,
                  path: url.pathname + url.search,
                  ca,
                  headers: { host: url.hostname },
                  lookup: (_name, _options, callback) =>
                    callback(null, [{ address: "127.0.0.1", family: 4 }]),
                },
                (response) => {
                  response.resume();
                  done({
                    status: response.statusCode ?? 0,
                    type: response.headers["content-type"],
                  });
                },
              )
              .on("error", fail);
          }),
      });
    });
  });
}

it("an attached image on an Enterprise Server takes the media host's URL, which loads without a session", async () => {
  const { load } = await standIn();
  const screenshot = `https://${GHE}/user-attachments/assets/${PNG}`;
  const legacy = `https://${GHE}/team07/game/assets/7/${LEGACY}`;
  const media = (id: string) =>
    `https://media.${GHE}/user/7/files/${id}?token=signed`;
  const body = [
    "#33 needs to merge first",
    `<img width="1512" alt="Screenshot 2026-10-16 at 7 08 44 AM" src="${screenshot}" />`,
    `![older](${legacy})`,
    `![gone](https://${GHE}/user-attachments/assets/${UNSIGNED})`,
  ].join("\r\n\r\n");
  // The Server's rendering: each image linked to itself, the one GitHub
  // couldn't sign left at its attachment URL, and an image elsewhere
  // whose path holds an attachment's id.
  const { list, graphql: answer } = answers(GHE);
  writeFileSync(
    list,
    JSON.stringify([
      pullRequest(
        `https://${GHE}/team07/game/pull/3`,
        "harper/gold-display",
        body,
      ),
    ]),
  );
  writeFileSync(
    answer,
    graphql(
      [
        `<p><a href="https://${GHE}/team07/game/pull/33">#33</a> needs to merge first</p>`,
        `<p><a href="${media(PNG)}"><img width="1512" alt="Screenshot" src="${media(PNG)}"></a></p>`,
        `<p><a href="${media(LEGACY)}"><img src="${media(LEGACY)}" alt="older"></a></p>`,
        `<p><a href="https://${GHE}/user-attachments/assets/${UNSIGNED}"><img src="https://tracker.example/${UNSIGNED}?t=1" alt="gone"></a></p>`,
      ].join("\n"),
    ),
  );
  const repo = repoOn("enterprise", `git@${GHE}:team07/game.git`);

  assert.equal(
    (await load(screenshot)).status,
    302,
    "an attachment asks to sign in",
  );
  const shown = (await getWorktreePullRequest(repo, "harper/gold-display"))
    ?.body;
  assert.equal(
    shown,
    [
      "#33 needs to merge first",
      `<img width="1512" alt="Screenshot 2026-10-16 at 7 08 44 AM" src="${media(PNG)}" />`,
      `![older](${media(LEGACY)})`,
      `![gone](https://${GHE}/user-attachments/assets/${UNSIGNED})`,
    ].join("\r\n\r\n"),
    "images on the media host, one GitHub didn't sign as written",
  );
  for (const id of [PNG, LEGACY]) {
    assert.deepEqual(await load(media(id)), { status: 200, type: "image/png" });
  }
});
