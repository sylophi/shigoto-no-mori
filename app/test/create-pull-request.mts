// Durable proof of the create pull request dialog's host side.
//
// Creating a PR pushes the branch first and hands gh what the dialog
// said. gh finds the PR's head through the branch's upstream, so a
// branch never pushed is published (and gains one), and a branch that
// has one pushes to it. Every value goes to gh joined to its flag, so a
// title or a label starting with a dash stays one. A file pasted into
// the description is staged a chunk at a time, in order, and goes to
// gh's --attach by its staged path, which the body's `./<name>`
// references are rewritten to, since gh matches them by absolute path.
// The staged files are gone once the PR is made, and kept for another
// try when it isn't. A PR gh made while an attachment failed is an
// answer with a warning, and a gh too old for --attach says so.
//
// The dialog's reads: the base a stacked branch belongs on (the nearest
// open PR's head below it, at its remote-tracking ref), gh's --fill
// from the commits since that base, the repo's template, what a PR into
// a base would hold, and the repo's people and labels, read once.
//
// Drives the real host code against a fake gh on PATH, which writes
// the arguments it was given to a file, and a repo whose remote is on
// github.com, pushed to a bare repo beside it (pushInsteadOf, which
// leaves the fetch URL, the one gh's gate reads, on github.com). The
// pushes keep the remote-tracking refs. Run: pnpm test create-pull-request.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NewPullRequest from "@host/lib/githubCli/newPullRequest";
import { afterAll, beforeAll, it } from "vitest";
import { runHost } from "./lib/hostRuntime.mts";
import { hostEngine } from "./lib/smBinary.mts";
import {
  installFakeGh,
  sandboxGit,
  scrubProcessGitEnv,
  tempDir,
} from "./lib/checkKit.mts";
import { trackTest } from "./lib/vitestKit.mts";

const comparePullRequest = (
  ...args: Parameters<typeof NewPullRequest.comparePullRequest>
) => runHost(NewPullRequest.comparePullRequest(...args));
const createPullRequest = (
  ...args: Parameters<typeof NewPullRequest.createPullRequest>
) => runHost(NewPullRequest.createPullRequest(...args));
const discardAttachment = (id: string) =>
  runHost(NewPullRequest.discardAttachment(id));
const getPullRequestDraft = (
  ...args: Parameters<typeof NewPullRequest.getPullRequestDraft>
) => runHost(NewPullRequest.getPullRequestDraft(...args));
const stageAttachmentFromUrl = (
  ...args: Parameters<typeof NewPullRequest.stageAttachmentFromUrl>
) => runHost(NewPullRequest.stageAttachmentFromUrl(...args));
const getPullRequestOptions = (cwd: string) =>
  runHost(NewPullRequest.getPullRequestOptions(cwd));
const stageAttachment = (
  ...args: Parameters<typeof NewPullRequest.stageAttachment>
) => runHost(NewPullRequest.stageAttachment(...args));

const PR_URL = "https://github.com/o/r/pull/7";
const TOP = "stack-top_layer";

const pr = (
  number: number,
  headRefName: string,
  state = "OPEN",
  isCrossRepository = false,
) => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  title: `PR ${number}`,
  state,
  isDraft: false,
  headRefName,
  baseRefName: "main",
  isCrossRepository,
});

// The repo's PRs, newest first. bottom and mid are open layers below
// the top, mid the nearer. stale sits where main is, other is beside
// the stack, closed-one and the fork's forked are each nearer than mid
// but no base: one closed, the other another repository's.
const PR_LIST = [
  pr(20, TOP),
  pr(19, "closed-one", "CLOSED"),
  pr(18, "forked", "OPEN", true),
  pr(17, "other"),
  pr(16, "stale"),
  pr(15, "mid"),
  pr(14, "bottom"),
];

const OPTIONS = {
  data: {
    viewer: { login: "me" },
    repository: {
      assignableUsers: {
        nodes: [{ login: "me", name: "Me" }, null, { login: "al", name: null }],
      },
      labels: {
        nodes: [{ name: "bug", color: "d73a4a", description: null }],
      },
    },
  },
};

// One argument per NUL, so a body's newlines survive. What a pr create
// does is read from `mode`: succeed, make the PR with an attachment
// failing, or be a gh from before --attach. Every attached file's bytes
// are copied out while gh runs, as the upload would read them.
const gh = (dir: string) => `#!/bin/sh
dir='${dir}'
case "$*" in
  "auth token"*) ;;
  "pr list --state all --limit "*) cat "$dir/pr-list.json";;
  "api graphql "*assignableUsers*) echo call >> "$dir/options-calls"
    cat "$dir/options.json";;
  "pr create "*) printf '%s\\0' "$@" > "$dir/gh-args"
    : > "$dir/attached"
    for arg in "$@"; do
      case "$arg" in --attach=*) cat "\${arg#--attach=}" >> "$dir/attached";; esac
    done
    case "$(cat "$dir/mode")" in
      ok) echo '${PR_URL}';;
      partial) echo 'https://github.com/o/r/pull/8'
        echo 'failed to upload clip.mp4: HTTP 500' >&2; exit 1;;
      old) printf 'unknown flag: --attach\\n\\nUsage:  gh pr create [flags]\\n\\nFlags:\\n  -B, --base branch  The branch into which you want your code merged\\n' >&2
        exit 1;;
    esac;;
  "pr view "*" --json body") cat "$dir/view.json";;
  "pr edit "*) printf '%s\\0' "$@" > "$dir/edit-args";;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`;

// A fake gh on PATH, signed in, and a stack of branches in a repo on
// "github.com", pushed to a bare repo beside it:
//
//   main ── bottom (Add b) ── mid (Ship the binary) ── top (two commits)
//
// with mid pushed and then moved on locally to a commit of its own on
// bottom, so only its remote-tracking ref is below the top.
function setup() {
  const root = tempDir("sm-create-pr-", trackTest);
  installFakeGh(root, gh(root), trackTest);
  writeFileSync(join(root, "pr-list.json"), JSON.stringify(PR_LIST));
  writeFileSync(join(root, "options.json"), JSON.stringify(OPTIONS));
  writeFileSync(join(root, "mode"), "ok");
  writeFileSync(join(root, "view.json"), JSON.stringify({ body: "" }));
  const git = sandboxGit();
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  git(root, "init", "-q", "--bare", remote);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "remote", "add", "origin", "https://github.com/o/r.git");
  git(
    repo,
    "config",
    `url.${remote}.pushInsteadOf`,
    "https://github.com/o/r.git",
  );
  const commit = (
    files: Record<string, string | Buffer>,
    ...message: string[]
  ) => {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(repo, name), content);
      git(repo, "add", name);
    }
    git(repo, "commit", "-q", ...message.flatMap((m) => ["-m", m]));
  };
  commit({ "a.txt": "one\n" }, "base");
  git(repo, "push", "-q", "-u", "origin", "main");
  git(repo, "branch", "stale");
  git(repo, "switch", "-q", "-c", "other");
  commit({ "o.txt": "o\n" }, "Other work");
  git(repo, "switch", "-q", "-c", "bottom", "main");
  commit({ "b.txt": "b\nb\n" }, "Add b", "Why b.\n\nMore about b.");
  git(repo, "push", "-q", "-u", "origin", "bottom");
  git(repo, "switch", "-q", "-c", "mid");
  commit(
    { "a.txt": "uno\ntwo\n", "bin.dat": Buffer.from([0, 1, 2, 0, 255]) },
    "Ship the binary",
  );
  git(repo, "push", "-q", "-u", "origin", "mid");
  git(repo, "switch", "-q", "-c", TOP);
  commit({ "c.txt": "c1\nc2\nx\n" }, "Add the top layer");
  git(repo, "branch", "forked");
  // What the app's PR checkout writes for a fork's PR (#18).
  git(repo, "config", "branch.forked.remote", "origin");
  git(repo, "config", "branch.forked.merge", "refs/pull/18/head");
  git(repo, "branch", "closed-one");
  commit({ "c.txt": "c1\nc2\nc3\n" }, "Polish the top layer");
  git(repo, "switch", "-q", "mid");
  git(repo, "reset", "-q", "--hard", "bottom");
  commit({ "m.txt": "m\n" }, "local only");
  git(repo, "switch", "-q", TOP);

  const argsOf = (file: string) =>
    readFileSync(join(root, file), "utf8").split("\0").slice(0, -1);
  const args = () => argsOf("gh-args");
  const editArgs = () =>
    existsSync(join(root, "edit-args")) ? argsOf("edit-args") : null;
  const remoteHead = (branch: string) =>
    git(remote, "rev-parse", branch).trim();
  const head = () => git(repo, "rev-parse", "HEAD").trim();
  return {
    root,
    repo,
    remote,
    git,
    commit,
    args,
    editArgs,
    remoteHead,
    head,
  };
}

const NO_EXTRAS = {
  reviewers: [],
  assignees: [],
  labels: [],
  attachments: [],
};

const stagedDir = (id: string) =>
  join(tmpdir(), "shigomori-pr-attachments", id);

// A whole file, in one chunk.
const stage = (file: { id: string; name: string }, text: string) =>
  stageAttachment({
    ...file,
    offset: 0,
    base64: Buffer.from(text).toString("base64"),
  });

scrubProcessGitEnv();

// The integration toggle is the store's: a fresh one has it on.
let dataDir: string;
let closeEngine: () => Promise<void>;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "sm-create-pr-data-"));
  ({ close: closeEngine } = await hostEngine(dataDir));
});
afterAll(async () => {
  await closeEngine();
  rmSync(dataDir, { recursive: true, force: true });
});

it("a stacked branch's base is the nearest open PR's head below it", async () => {
  const { repo, git } = setup();
  const draft = (branch: string) =>
    getPullRequestDraft({
      cwd: repo,
      project: { id: repo, path: repo },
      branch,
      primaryRef: "origin/main",
    });

  const top = await draft(TOP);
  assert.equal(
    top.suggestedBase,
    "mid",
    "mid, at origin/mid: its local branch moved off the stack",
  );
  assert.deepEqual(
    top.fill,
    {
      title: "stack top layer",
      body: "- **Add the top layer**\n- **Polish the top layer**",
    },
    "several commits: the branch name, humanized, and their subjects",
  );

  git(repo, "switch", "-q", "bottom");
  const bottom = await draft("bottom");
  assert.equal(bottom.suggestedBase, null, "nothing below but main");
  assert.deepEqual(
    bottom.fill,
    { title: "Add b", body: "Why b.\n\nMore about b." },
    "one commit: its own message, against the primary ref",
  );
});

it("the repo's PR template", async () => {
  const { repo } = setup();
  const template = async () =>
    (
      await getPullRequestDraft({
        cwd: repo,
        project: { id: repo, path: repo },
        branch: TOP,
        primaryRef: "origin/main",
      })
    ).template;

  assert.equal(await template(), null, "none without a template");
  mkdirSync(join(repo, ".github", "PULL_REQUEST_TEMPLATE"), {
    recursive: true,
  });
  writeFileSync(
    join(repo, ".github", "PULL_REQUEST_TEMPLATE", "bug.md"),
    "a choice",
  );
  assert.equal(await template(), null, "a folder of several is no default");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "pull_request_template.md"), "docs");
  assert.equal(await template(), "docs");
  writeFileSync(join(repo, ".github", "Pull-Request-Template.md"), "github");
  assert.equal(
    await template(),
    "github",
    ".github first, the name in either case and with dashes",
  );
});

it("a compare holds the branch's commits since the base and their totals", async () => {
  const { repo } = setup();
  assert.deepEqual(
    await comparePullRequest(repo, "mid"),
    { commits: 2, files: 1, additions: 3, deletions: 0 },
    "since origin/mid (the local mid would add one)",
  );

  const onMain = await comparePullRequest(repo, "main");
  assert.equal(onMain.commits, 4);
  assert.deepEqual(
    {
      files: onMain.files,
      additions: onMain.additions,
      deletions: onMain.deletions,
    },
    { files: 4, additions: 7, deletions: 1 },
    "a binary file counts as a file with no lines",
  );

  await assert.rejects(
    comparePullRequest(repo, "nope"),
    /no branch named nope/,
  );
  await assert.rejects(
    comparePullRequest(repo, "--all"),
    /no branch named --all/,
    "a base is only ever a branch name",
  );
});

it("the repo's people and labels are read once", async () => {
  const { root, repo } = setup();
  const first = await getPullRequestOptions(repo);
  assert.deepEqual(first, {
    viewer: "me",
    people: [
      { login: "me", name: "Me" },
      { login: "al", name: null },
    ],
    labels: [{ name: "bug", color: "d73a4a", description: null }],
  });
  assert.deepEqual(await getPullRequestOptions(repo), first);
  assert.equal(
    readFileSync(join(root, "options-calls"), "utf8"),
    "call\n",
    "the second read is the cached one",
  );
});

it("an attachment is staged a chunk at a time, in order", async () => {
  const id = "00000000000000a1";
  trackTest(() => rmSync(stagedDir(id), { recursive: true, force: true }));
  const chunk = (offset: number, text: string) =>
    stageAttachment({
      id,
      name: "shot.png",
      offset,
      base64: Buffer.from(text).toString("base64"),
    });
  const staged = join(stagedDir(id), "shot.png");
  await chunk(0, "hello ");
  await chunk(6, "world");
  await assert.rejects(chunk(3, "!"), /Attachment chunk out of order/);
  await assert.rejects(chunk(20, "!"), /Attachment chunk out of order/);
  assert.equal(readFileSync(staged, "utf8"), "hello world");
  // Each kind within GitHub's size for it, the image's checked here as
  // well as in the dialog.
  await assert.rejects(
    chunk(10 * 1024 * 1024 - 1, "!!"),
    /shot\.png is over the 10 MB GitHub takes/,
  );
  const other = (name: string, offset: number) =>
    stageAttachment({ id, name, offset, base64: "ISE=" });
  await assert.rejects(
    other("clip.mp4", 100 * 1024 * 1024 - 1),
    /clip\.mp4 is over the 100 MB GitHub takes/,
  );
  await assert.rejects(other("notes.pdf", 0), /Only images and videos/);
  await chunk(0, "again");
  assert.equal(readFileSync(staged, "utf8"), "again", "offset 0 starts over");

  // A new attachment clears what an abandoned form staged a day ago,
  // and leaves what's newer.
  const old = "00000000000000a2";
  trackTest(() => rmSync(stagedDir(old), { recursive: true, force: true }));
  await stageAttachment({
    id: old,
    name: "old.png",
    offset: 0,
    base64: Buffer.from("old").toString("base64"),
  });
  const dayAgo = new Date(Date.now() - 25 * 60 * 60_000);
  utimesSync(stagedDir(old), dayAgo, dayAgo);
  await chunk(0, "fresh");
  assert.ok(!existsSync(stagedDir(old)), "the day-old one is swept");
  assert.ok(existsSync(staged), "the new one stays");

  await discardAttachment(id);
  assert.ok(!existsSync(stagedDir(id)), "a discarded one is gone");
});

it("a linked image is fetched by its type, within GitHub's limits", async () => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 1);
  const server = createServer((req, res) => {
    const send = (type: string, body: Buffer | string) => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    };
    if (req.url === "/moved") {
      res.writeHead(302, { location: "/shot.jpg" });
      res.end();
    } else if (req.url === "/shot.jpg") send("image/png; q=1", "PNG");
    else if (req.url === "/page") send("text/html", "<p>hi</p>");
    else if (req.url === "/big") send("image/png", big);
    else if (req.url === "/empty") send("image/png", "");
    else if (req.url === "/empty-unsized") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end();
    } else if (req.url === "/big-unsized") {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(big.subarray(0, 6 * 1024 * 1024));
      res.end(big.subarray(6 * 1024 * 1024));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  trackTest(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const id = "00000000000000c1";
  trackTest(() => rmSync(stagedDir(id), { recursive: true, force: true }));
  const fetchAs = (path: string) =>
    stageAttachmentFromUrl(
      { id, stem: "shot", url: `${base}${path}` },
      { privateHosts: true },
    );

  await assert.rejects(
    stageAttachmentFromUrl({ id, stem: "shot", url: `${base}/shot.jpg` }),
    /points at this machine or its network/,
    "a link to this machine isn't fetched for a PR",
  );
  await Promise.all(
    ["localhost", "10.0.0.8", "192.168.1.1", "[::1]", "printer.local"].map(
      (host) =>
        assert.rejects(
          stageAttachmentFromUrl({
            id,
            stem: "shot",
            url: `http://${host}/a.png`,
          }),
          /points at this machine or its network/,
          host,
        ),
    ),
  );

  assert.deepEqual(
    await fetchAs("/moved"),
    { name: "shot.png", type: "image/png" },
    "named by the type it came as, after a redirect",
  );
  assert.equal(readFileSync(join(stagedDir(id), "shot.png"), "utf8"), "PNG");
  await discardAttachment(id);
  await assert.rejects(fetchAs("/page"), /Only images and videos/);
  await assert.rejects(fetchAs("/nope"), /HTTP 404/);
  await assert.rejects(fetchAs("/big"), /over the 10 MB/);
  await assert.rejects(
    fetchAs("/big-unsized"),
    /over the 10 MB/,
    "counted as it comes when it doesn't say its size",
  );
  // An empty one, as the dialog refuses an empty file.
  await assert.rejects(fetchAs("/empty"), /is empty/);
  await assert.rejects(fetchAs("/empty-unsized"), /is empty/);
  assert.ok(!existsSync(stagedDir(id)), "a refused one leaves nothing");
});

it("a branch is pushed, then gh opens the PR", async () => {
  const { repo, git, commit, args, remoteHead, head } = setup();

  const created = await createPullRequest({
    cwd: repo,
    project: { id: repo, path: repo },
    base: "mid",
    title: "-v: a dashed title",
    body: "line one\nline two",
    draft: true,
    ...NO_EXTRAS,
  });
  assert.deepEqual(created, { url: PR_URL, warning: null });
  assert.equal(remoteHead(TOP), head(), "the branch was published");
  assert.equal(
    git(repo, "rev-parse", "--abbrev-ref", `${TOP}@{u}`).trim(),
    `origin/${TOP}`,
    "and tracks what it was published to",
  );
  assert.deepEqual(args(), [
    "pr",
    "create",
    "--base=mid",
    "--title=-v: a dashed title",
    "--body=line one\nline two",
    "--draft",
  ]);

  // A push of the PR's branch alone, whatever push.default says:
  // `matching` would take bottom's local commit along.
  git(repo, "config", "push.default", "matching");
  git(repo, "switch", "-q", "bottom");
  commit({ "e.txt": "e\n" }, "unpushed on bottom");
  git(repo, "switch", "-q", TOP);
  const bottomBefore = remoteHead("bottom");
  commit({ "d.txt": "d\n" }, "more");
  await createPullRequest({
    cwd: repo,
    project: { id: repo, path: repo },
    base: "main",
    title: "Ready",
    body: "",
    draft: false,
    reviewers: ["al", "o/team"],
    assignees: ["me"],
    labels: ["bug", "-wip", "a, b", 'say "hi"'],
    attachments: [],
  });
  assert.equal(remoteHead(TOP), head(), "a tracked branch pushes its upstream");
  assert.equal(remoteHead("bottom"), bottomBefore, "and nothing else");
  assert.deepEqual(args(), [
    "pr",
    "create",
    "--base=main",
    "--title=Ready",
    "--body=",
    "--reviewer=al",
    "--reviewer=o/team",
    "--assignee=me",
    "--label=bug",
    "--label=-wip",
    '--label="a, b"',
    '--label="say ""hi"""',
  ]);

  // A branch started from origin/main tracks main: publishing it
  // under its own name, never pushing it onto main.
  git(repo, "switch", "-q", "-c", "from-main", "--track", "origin/main");
  commit({ "f.txt": "f\n" }, "from main");
  const mainBefore = remoteHead("main");
  await createPullRequest({
    cwd: repo,
    project: { id: repo, path: repo },
    base: "main",
    title: "From main",
    body: "",
    draft: false,
    ...NO_EXTRAS,
  });
  assert.equal(remoteHead("main"), mainBefore, "main is left alone");
  assert.equal(remoteHead("from-main"), head(), "published by its name");
  assert.equal(
    git(repo, "rev-parse", "--abbrev-ref", "from-main@{u}").trim(),
    "origin/from-main",
  );
});

it("attachments go to gh by their staged paths, then are removed", async () => {
  const { root, repo, git, remote, args, editArgs } = setup();
  const shot = { id: "00000000000000b1", name: "shot.png" };
  const clip = { id: "00000000000000b2", name: "clip.mp4" };
  for (const { id } of [shot, clip]) {
    trackTest(() => rmSync(stagedDir(id), { recursive: true, force: true }));
  }
  const shotPath = join(stagedDir(shot.id), shot.name);
  const clipPath = join(stagedDir(clip.id), clip.name);
  const body = [
    "![shot](./shot.png)",
    "[clip](<./clip.mp4>)",
    "Mentioned as `./shot.png`, and ![other](./other.png).",
    "Written ``![shot](./shot.png)`` in a span, ![shot](./shot.png) not.",
    "A lone ` is no span: ![shot](./shot.png)",
    "````md",
    "![shot](./shot.png) is how it's written",
    "```",
    "````",
    "![shot](./shot.png)",
  ].join("\n");
  const create = () =>
    createPullRequest({
      cwd: repo,
      project: { id: repo, path: repo },
      base: "main",
      title: "With files",
      body,
      draft: false,
      ...NO_EXTRAS,
      attachments: [shot, clip],
    });

  await stage(shot, "PNG");
  await assert.rejects(create(), /clip\.mp4 is no longer attached/);
  assert.equal(git(remote, "branch", "--list", TOP), "", "nothing was pushed");

  await stage(clip, "MP4");
  assert.deepEqual(await create(), { url: PR_URL, warning: null });
  assert.deepEqual(args(), [
    "pr",
    "create",
    "--base=main",
    "--title=With files",
    [
      `--body=![shot](${shotPath})`,
      `[clip](<${clipPath}>)`,
      "Mentioned as `./shot.png`, and ![other](./other.png).",
      `Written \`\`![shot](./shot.png)\`\` in a span, ![shot](${shotPath}) not.`,
      `A lone \` is no span: ![shot](${shotPath})`,
      "````md",
      "![shot](./shot.png) is how it's written",
      "```",
      "````",
      `![shot](${shotPath})`,
    ].join("\n"),
    `--attach=${shotPath}`,
    `--attach=${clipPath}`,
  ]);
  assert.equal(
    readFileSync(join(root, "attached"), "utf8"),
    "PNGMP4",
    "the staged files were there while gh ran",
  );
  assert.ok(
    !existsSync(stagedDir(shot.id)) && !existsSync(stagedDir(clip.id)),
    "and are gone after",
  );

  assert.equal(editArgs(), null, "a body gh rewrote whole is left be");

  // gh leaves what didn't upload as it was, a staged path, which is
  // put back to the name the description had.
  writeFileSync(join(root, "mode"), "partial");
  writeFileSync(
    join(root, "view.json"),
    JSON.stringify({
      body: `![shot](https://github.com/user-attachments/assets/1)\n[clip](<${clipPath}>)`,
    }),
  );
  await stage(shot, "PNG");
  await stage(clip, "MP4");
  assert.deepEqual(
    await create(),
    {
      url: "https://github.com/o/r/pull/8",
      warning: "failed to upload clip.mp4: HTTP 500",
    },
    "a PR gh made despite a failed upload is an answer, with a warning",
  );
  assert.deepEqual(editArgs(), [
    "pr",
    "edit",
    "https://github.com/o/r/pull/8",
    "--body=![shot](https://github.com/user-attachments/assets/1)\n[clip](<./clip.mp4>)",
  ]);
  assert.ok(
    !existsSync(stagedDir(shot.id)),
    "removed once the PR has them, even with one missing",
  );

  writeFileSync(join(root, "mode"), "old");
  await stage(shot, "PNG");
  await stage(clip, "MP4");
  await assert.rejects(create(), {
    message: "Attaching files needs GitHub CLI 2.99 or newer.",
  });
  assert.ok(existsSync(stagedDir(clip.id)), "kept for another try");
});
