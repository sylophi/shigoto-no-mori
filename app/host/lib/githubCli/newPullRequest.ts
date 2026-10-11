// The create pull request dialog's host side: where it starts (the base a
// stacked branch belongs on, gh's --fill, the repo's template), what a
// PR into a base would hold, who and what it can name, the files pasted
// into its description, and the create itself.
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  ATTACHMENT_IMAGE_EXTENSIONS,
  ATTACHMENT_VIDEO_EXTENSIONS,
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_VIDEO_BYTES,
  type StagedAttachment,
  type CreatePullRequestResult,
  isFromThisRepository,
  type PullRequestCompare,
  type PullRequestDraft,
  type PullRequestOptions,
} from "@shared/schemas";
import { orderRemotesByPrecedence } from "@shared/git/defaultBranch.mts";
import { errorMessageOf } from "@shared/errors";
import { parseNumstat } from "../git/changes";
import { run, runLenient } from "../git/core";
import { countCommits } from "../git/refs";
import { listRemotes } from "../git/remotes";
import { publishCurrentBranch } from "../git/sync";
import { ttlMapCache } from "../util/ttlCache";
import { ghStream, runGh } from "./actions";
import {
  evictProjectPullRequests,
  listProjectPullRequests,
} from "./pullRequests";

// Every local branch and remote-tracking ref by its full name, or only
// those whose tip `mergedInto` reaches.
async function refNames(
  cwd: string,
  mergedInto?: string,
): Promise<Set<string>> {
  const out = await run(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    ...(mergedInto ? [`--merged=${mergedInto}`] : []),
    "refs/heads/",
    "refs/remotes/",
  ]);
  return new Set(out.split("\n").filter(Boolean));
}

// The ref a branch is compared at: its remote-tracking ref, which is
// what GitHub holds and the PR merges into, in the remotes' precedence
// (upstream, origin, the rest), else the local branch. Null when
// neither exists. Built from full names, so no branch name can read as
// a flag or a revision expression.
function trackedRef(
  branch: string,
  refs: Set<string>,
  remotes: string[],
): string | null {
  for (const remote of remotes) {
    const ref = `refs/remotes/${remote}/${branch}`;
    if (refs.has(ref)) return ref;
  }
  const local = `refs/heads/${branch}`;
  return refs.has(local) ? local : null;
}

async function orderedRemotes(cwd: string): Promise<string[]> {
  return orderRemotesByPrecedence(await listRemotes(cwd));
}

// The worktree a draft is read for: its checkout, its project's, the
// branch it has out and the project's primary ref.
interface DraftSource {
  cwd: string;
  projectPath: string;
  branch: string;
  primaryRef: string | undefined;
}

export async function getPullRequestDraft(
  opts: DraftSource,
): Promise<PullRequestDraft> {
  const { cwd, primaryRef } = opts;
  const [stack, template] = await Promise.all([
    stackBase(opts),
    readPullRequestTemplate(cwd),
  ]);
  const fillBase = stack?.ref ?? primaryRef;
  return {
    suggestedBase: stack?.branch ?? null,
    fill: fillBase
      ? await fillFrom(cwd, fillBase, opts.branch)
      : { title: "", body: "" },
    template,
  };
}

// The branch a stacked branch belongs on: of the open PRs from this
// repository, the head nearest below HEAD. A head HEAD sits on exactly
// would make an empty PR, and one the primary branch already holds is
// no step above it, so neither counts.
async function stackBase(
  opts: DraftSource,
): Promise<{ branch: string; ref: string } | null> {
  const { cwd, primaryRef } = opts;
  const prs = await listProjectPullRequests(opts.projectPath);
  const heads = [...prs].flatMap(([head, pr]) =>
    head !== opts.branch && pr.state === "OPEN" && isFromThisRepository(pr)
      ? [head]
      : [],
  );
  if (heads.length === 0) return null;
  const [refs, below, landed, remotes] = await Promise.all([
    refNames(cwd),
    refNames(cwd, "HEAD"),
    primaryRef ? refNames(cwd, primaryRef) : Promise.resolve(new Set<string>()),
    orderedRemotes(cwd),
  ]);
  const candidates = heads.flatMap((branch) => {
    const ref = trackedRef(branch, refs, remotes);
    return ref && below.has(ref) && !landed.has(ref) ? [{ branch, ref }] : [];
  });
  const distances = await Promise.all(
    candidates.map(({ ref }) => countCommits(cwd, [`${ref}..HEAD`])),
  );
  let nearest: { branch: string; ref: string } | null = null;
  let fewest = Infinity;
  for (const [i, candidate] of candidates.entries()) {
    const distance = distances[i] ?? 0;
    if (distance > 0 && distance < fewest) {
      nearest = candidate;
      fewest = distance;
    }
  }
  return nearest;
}

// What `gh pr create --fill` writes (initDefaultTitleBody in gh's
// pkg/cmd/pr/create/create.go), from the same commits: HEAD's side of
// `base...HEAD` without merges or ones the base already has a copy of.
// One commit gives its own message. Several give the branch name with
// its dashes and underscores made spaces (gh's humanize, which changes
// nothing else), and a list of their subjects, oldest first. gh ends
// either with a newline, which a text box only shows as a stray line.
async function fillFrom(
  cwd: string,
  base: string,
  branch: string,
): Promise<{ title: string; body: string }> {
  const out = await run(cwd, [
    "-c",
    "log.ShowSignature=false",
    "log",
    "--cherry",
    "--pretty=format:%H%x00%s%x00%b%x00",
    "--end-of-options",
    `${base}...HEAD`,
    "--",
  ]);
  const fields = out.split("\0");
  const commits: { subject: string; body: string }[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    commits.push({ subject: fields[i + 1] ?? "", body: fields[i + 2] ?? "" });
  }
  const [only] = commits;
  if (only === undefined) return { title: "", body: "" };
  if (commits.length === 1) {
    return { title: only.subject, body: only.body.trimEnd() };
  }
  return {
    title: branch.replace(/[-_]/g, " "),
    body: commits
      .toReversed()
      .map((commit) => `- **${commit.subject}**`)
      .join("\n"),
  };
}

// gh's own lookup for the single template (FindLegacy in its
// pkg/githubtemplate), which GitHub also fills a new PR with: the first
// file, by name, in .github, the root, then docs, named
// pull_request_template with any extension and either case, a dash for
// either underscore allowed. A PULL_REQUEST_TEMPLATE folder holds a
// choice of several, which is left to GitHub's own page. Symlinks are
// skipped as gh skips them.
const TEMPLATE_NAME = /^pull[_-]request[_-]template(\.|$)/i;

async function readPullRequestTemplate(cwd: string): Promise<string | null> {
  const found = await Promise.all(
    [".github", ".", "docs"].map(async (dir) => {
      const entries = await readdir(join(cwd, dir), {
        withFileTypes: true,
      }).catch(() => []);
      const file = entries
        .filter((entry) => entry.isFile() && TEMPLATE_NAME.test(entry.name))
        .map((entry) => entry.name)
        .toSorted()[0];
      return file === undefined ? null : join(cwd, dir, file);
    }),
  );
  const template = found.find((path) => path !== null);
  return template ? readFile(template, "utf8") : null;
}

// How many commits the branch has since it left `base`, and what they
// change together, as GitHub's compare would count them.
export async function comparePullRequest(
  cwd: string,
  base: string,
): Promise<PullRequestCompare> {
  const [refs, remotes] = await Promise.all([
    refNames(cwd),
    orderedRemotes(cwd),
  ]);
  const ref = trackedRef(base, refs, remotes);
  if (!ref)
    throw new Error(`There is no branch named ${base} to compare with.`);
  const mergeBase = (
    await runLenient(cwd, ["merge-base", "--end-of-options", "HEAD", ref])
  ).trim();
  if (!mergeBase) {
    throw new Error(`This branch shares no history with ${base}.`);
  }
  const [commits, counts] = await Promise.all([
    countCommits(cwd, [`${mergeBase}..HEAD`]),
    run(cwd, ["diff", "--numstat", "-z", mergeBase, "HEAD", "--"]).then(
      parseNumstat,
    ),
  ]);
  // A binary file has no counts: a file, with no lines to add up.
  let additions = 0;
  let deletions = 0;
  for (const count of counts.values()) {
    additions += count?.additions ?? 0;
    deletions += count?.deletions ?? 0;
  }
  return { commits, files: counts.size, additions, deletions };
}

// One read for the dialog's pickers. gh fills {owner} and {repo} from the
// repo's remote, as for repoConfig.ts's query. A list GitHub couldn't
// resolve an entry of answers a null in its place.
const PULL_REQUEST_OPTIONS_QUERY =
  "query($owner: String!, $name: String!) { viewer { login } " +
  "repository(owner: $owner, name: $name) { " +
  "assignableUsers(first: 100) { nodes { login name } } " +
  "labels(first: 100, orderBy: {field: NAME, direction: ASC}) " +
  "{ nodes { name color description } } } }";

const nodesOf = <T extends z.ZodType>(node: T) =>
  z.object({ nodes: z.array(node.nullable()) });

const GhPullRequestOptionsSchema = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z.object({
      assignableUsers: nodesOf(
        z.object({ login: z.string(), name: z.string().nullable() }),
      ),
      labels: nodesOf(
        z.object({
          name: z.string(),
          color: z.string(),
          description: z.string().nullable(),
        }),
      ),
    }),
  }),
});

// A repo's people and labels change rarely, and the dialog reopens often.
// The loader throws on a failure, so only a successful read is cached.
const PULL_REQUEST_OPTIONS_TTL_MS = 5 * 60_000;

const pullRequestOptionsCache = ttlMapCache<string, PullRequestOptions>(
  PULL_REQUEST_OPTIONS_TTL_MS,
  async (cwd) => {
    const stdout = await runGh(
      [
        "api",
        "graphql",
        "-F",
        "owner={owner}",
        "-F",
        "name={repo}",
        "-f",
        `query=${PULL_REQUEST_OPTIONS_QUERY}`,
      ],
      { cwd, fallback: "Couldn't read the repository's people and labels" },
    );
    const { viewer, repository } = GhPullRequestOptionsSchema.parse(
      JSON.parse(stdout),
    ).data;
    return {
      viewer: viewer.login,
      people: repository.assignableUsers.nodes.flatMap((n) => (n ? [n] : [])),
      labels: repository.labels.nodes.flatMap((n) => (n ? [n] : [])),
    };
  },
);

export function getPullRequestOptions(
  cwd: string,
): Promise<PullRequestOptions> {
  return pullRequestOptionsCache.get(cwd);
}

// Pasted files wait here, one folder per attachment, until the PR that
// uploads them is created. GitHub takes a video of up to 100 MiB, an
// image of far less, so nothing larger is worth holding.
const ATTACHMENTS_DIR = join(tmpdir(), "shigomori-pr-attachments");

function stagedAttachmentPath(id: string, name: string): string {
  return join(ATTACHMENTS_DIR, id, name);
}

// A form left unsent keeps its files, so each new attachment clears the
// ones staged over a day ago: by then the form that held them is gone
// with the app session, or an attachment of it reads as no longer
// attached and is added again.
const STALE_ATTACHMENT_MS = 24 * 60 * 60_000;

async function sweepStaleAttachments(): Promise<void> {
  const ids = await readdir(ATTACHMENTS_DIR).catch(() => []);
  const cutoff = Date.now() - STALE_ATTACHMENT_MS;
  await Promise.all(
    ids.map(async (id) => {
      const dir = join(ATTACHMENTS_DIR, id);
      const at = await stat(dir).then(
        (s) => s.mtimeMs,
        () => null,
      );
      if (at !== null && at < cutoff) {
        await rm(dir, { recursive: true, force: true });
      }
    }),
  );
}

// An attachment taken out of the form.
export async function discardAttachment(id: string): Promise<void> {
  await rm(join(ATTACHMENTS_DIR, id), { recursive: true, force: true });
}

// Writes one chunk. The first starts the file over, and every later one
// must land where the file ends, so a chunk lost or repeated in transit
// fails the paste rather than leaving a corrupt file to upload.
export async function stageAttachment(chunk: {
  id: string;
  name: string;
  offset: number;
  base64: string;
}): Promise<void> {
  const path = stagedAttachmentPath(chunk.id, chunk.name);
  const bytes = Buffer.from(chunk.base64, "base64");
  if (chunk.offset + bytes.length > MAX_ATTACHMENT_VIDEO_BYTES) {
    throw new Error(
      `An attachment can be at most ${MAX_ATTACHMENT_VIDEO_BYTES / 1024 / 1024} MB.`,
    );
  }
  if (chunk.offset === 0) {
    await sweepStaleAttachments();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return;
  }
  const size = await stat(path).then(
    (s) => s.size,
    () => null,
  );
  if (size !== chunk.offset) throw new Error("Attachment chunk out of order");
  await appendFile(path, bytes);
}

// How long a linked image or video gets to arrive.
const FETCH_TIMEOUT_MS = 120_000;

// Fetches a file dropped or pasted in as a link, here rather than in the
// renderer, which a site's CORS rules would stop. It has to come as a type
// gh uploads and within its size, and is named by that type, whatever
// the URL ends in. A failed fetch leaves nothing behind.
export async function stageAttachmentFromUrl(
  source: { id: string; stem: string; url: string },
  // The proofs serve their files from this machine.
  opts: { privateHosts?: boolean } = {},
): Promise<StagedAttachment> {
  const response = await fetchLink(source.url, opts.privateHosts ?? false);
  if (!response.ok || !response.body) {
    throw new Error(`Couldn't fetch ${source.url}: HTTP ${response.status}`);
  }
  const type =
    (response.headers.get("content-type") ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase() ?? "";
  const image = ATTACHMENT_IMAGE_EXTENSIONS[type];
  const ext = image ?? ATTACHMENT_VIDEO_EXTENSIONS[type];
  if (!ext) {
    await response.body.cancel();
    throw new Error(
      `Only images and videos can be attached, and ${source.url} is neither`,
    );
  }
  const max = image ? MAX_ATTACHMENT_IMAGE_BYTES : MAX_ATTACHMENT_VIDEO_BYTES;
  const tooBig = `${source.url} is over the ${max / 1024 / 1024} MB GitHub takes`;
  if (Number(response.headers.get("content-length") ?? 0) > max) {
    await response.body.cancel();
    throw new Error(tooBig);
  }
  const name = `${source.stem}.${ext}`;
  const path = stagedAttachmentPath(source.id, name);
  await sweepStaleAttachments();
  await mkdir(dirname(path), { recursive: true });
  try {
    let size = 0;
    // fetch's stream is typed as the DOM's, which node's is.
    const body = response.body as NodeReadableStream<Uint8Array>;
    const counted = Readable.fromWeb(body).on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > max) counted.destroy(new Error(tooBig));
    });
    await pipeline(counted, createWriteStream(path));
  } catch (err) {
    await discardAttachment(source.id);
    throw err;
  }
  return { name, type };
}

// A link is followed only as far as the web: one HTML from a page can
// hold, at this machine or its network (a router's snapshot, a local
// server), would be fetched from here and published on the PR. Every
// redirect is checked the same way. A name that resolves privately
// isn't caught, only one that says so.
const MAX_REDIRECTS = 5;

async function fetchLink(
  url: string,
  privateHosts: boolean,
): Promise<Response> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(current);
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error(`${url} isn't on the web`);
    }
    if (!privateHosts && isPrivateHost(target.hostname)) {
      throw new Error(`${url} points at this machine or its network`);
    }
    // One hop at a time, each checked before it's taken.
    // oxlint-disable-next-line no-await-in-loop -- a redirect needs the last answer
    const response = await fetch(current, { redirect: "manual", signal }).catch(
      (err: unknown) => {
        throw new Error(`Couldn't fetch ${url}`, { cause: err });
      },
    );
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }
    // oxlint-disable-next-line no-await-in-loop -- a redirect needs the last answer
    await response.body?.cancel();
    current = new URL(location, current).toString();
  }
  throw new Error(`${url} redirects too many times`);
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)
  ) {
    return true;
  }
  if (isIPv4(host)) {
    const [a = 0, b = 0] = host.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIPv6(host)) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
    if (mapped) return isPrivateHost(mapped);
    return host === "::" || host === "::1" || /^f[cd]|^fe[89ab]/.test(host);
  }
  return false;
}

// The shape of the URL gh prints for the new PR.
const PULL_REQUEST_URL = /^https?:\/\/\S+\/pull\/\d+$/;

// Uploads take as long as the files are large, beyond gh's usual 30s.
const CREATE_TIMEOUT_MS = 300_000;

// Opens a PR from the branch checked out at `cwd` into `base`. gh finds
// the head through the branch's upstream, so the branch is pushed
// first: to its upstream when it has one, else to the project's first
// remote, which becomes its upstream. Every value is joined to its
// flag, since a title, a login or a label may start with a dash.
//
// Attachments go up through gh's --attach (2.99 and later), which
// points a body's reference to an attached file at the uploaded copy.
// It matches a reference to a file by the absolute path it resolves to
// from gh's working directory, and that has to stay the worktree (gh
// finds the head branch there), so the `./<name>` the body was written
// with is swapped for the staged file's own path first. Only the two
// forms the dialog writes are swapped, as exactly as they're written.
export async function createPullRequest(opts: {
  cwd: string;
  projectPath: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
  reviewers: string[];
  assignees: string[];
  labels: string[];
  attachments: { id: string; name: string }[];
}): Promise<CreatePullRequestResult> {
  const { cwd, projectPath, attachments } = opts;
  const staged = attachments.map(({ id, name }) => ({
    id,
    name,
    path: stagedAttachmentPath(id, name),
  }));
  const present = await Promise.all(
    staged.map(({ path }) =>
      stat(path).then(
        (s) => s.isFile(),
        () => false,
      ),
    ),
  );
  const missing = staged.find((_, i) => !present[i]);
  if (missing) {
    throw new Error(`${missing.name} is no longer attached. Add it again.`);
  }
  const body = pointAtStaged(opts.body, staged);

  await pushForPullRequest(cwd, projectPath);

  const args = [
    "pr",
    "create",
    `--base=${opts.base}`,
    `--title=${opts.title}`,
    `--body=${body}`,
  ];
  if (opts.draft) args.push("--draft");
  for (const login of opts.reviewers) args.push(`--reviewer=${csv(login)}`);
  for (const login of opts.assignees) args.push(`--assignee=${csv(login)}`);
  for (const label of opts.labels) args.push(`--label=${csv(label)}`);
  for (const { path } of staged) args.push(`--attach=${path}`);

  // The staged files go once the PR has them. Until then they stay, so
  // trying again after a failed push or a refusal needs no new upload.
  const done = async (result: CreatePullRequestResult) => {
    await Promise.all(staged.map(({ id }) => discardAttachment(id)));
    return result;
  };
  try {
    const stdout = await runGh(args, {
      cwd,
      fallback: "gh pr create failed",
      timeout: CREATE_TIMEOUT_MS,
    });
    return await done({ url: pullRequestUrlOf(stdout), warning: null });
  } catch (err) {
    // When some attachments upload and others don't, gh still creates
    // the PR with those that did, prints its URL and exits non-zero.
    // The PR exists, so that is an answer with a warning beside it.
    // A reference to one that didn't upload is left as it was, holding
    // this machine's path, which goes back to the name it was written
    // with before anyone reads it.
    const url = pullRequestUrlOf(ghStream(err, "stdout"));
    if (url) {
      const unpublished = await restoreStagedReferences(cwd, url, staged).then(
        () => null,
        (restoreErr: unknown) =>
          `The description may still name a file's path on this machine. Edit it on GitHub. (${errorMessageOf(restoreErr)})`,
      );
      return await done({
        url,
        warning: [errorMessageOf(err), unpublished].filter(Boolean).join("\n"),
      });
    }
    // cobra prints its usage after the error, so runGh's message (the
    // last line) is the usage's and not what went wrong.
    if (ghStream(err, "stderr").includes("unknown flag: --attach")) {
      throw new Error("Attaching files needs GitHub CLI 2.99 or newer.", {
        cause: err,
      });
    }
    throw err;
  } finally {
    evictProjectPullRequests(projectPath);
  }
}

// The body with each `./<name>` reference the dialog wrote pointing at
// its staged file. Not inside code, a fenced block or an inline span,
// where gh leaves a path as it is and the reference is only text being
// shown.
function pointAtStaged(
  body: string,
  staged: readonly { name: string; path: string }[],
): string {
  let fence: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (fence === null) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) {
          fence = null;
        }
        return line;
      }
      if (fence !== null) return line;
      // An inline span runs from a run of backticks to the next run of
      // the same length. A run with none after it is only backticks.
      let span: string | null = null;
      const parts = line.split(/(`+)/);
      return parts
        .map((part, i) => {
          if (i % 2 === 1) {
            if (span === null) {
              if (parts.includes(part, i + 1)) span = part;
            } else if (part === span) span = null;
            return part;
          }
          if (span !== null) return part;
          let pointed = part;
          for (const { name, path } of staged) {
            pointed = pointed
              .replaceAll(`](./${name})`, `](${path})`)
              .replaceAll(`](<./${name}>)`, `](<${path}>)`);
          }
          return pointed;
        })
        .join("");
    })
    .join("\n");
}

// Pushes what the PR is made from. A branch tracking its own name on a
// remote pushes there, by name, so a `push.default` of `matching`
// doesn't take every other branch along. Any other branch (none
// tracked, a local one, or another name, like a branch started from
// origin/main) is published under its own name instead, which also
// makes that its upstream, where gh looks for the PR's head.
async function pushForPullRequest(
  cwd: string,
  projectPath: string,
): Promise<void> {
  const branch = (await run(cwd, ["symbolic-ref", "--short", "HEAD"])).trim();
  const config = async (key: string) =>
    (
      await runLenient(cwd, ["config", "--get", `branch.${branch}.${key}`])
    ).trim();
  const [remote, merge] = await Promise.all([
    config("remote"),
    config("merge"),
  ]);
  if (remote !== "" && remote !== "." && merge === `refs/heads/${branch}`) {
    await run(cwd, ["push", remote, `HEAD:${merge}`]);
    return;
  }
  await publishCurrentBranch(cwd, projectPath);
}

// gh reads a list flag's value as CSV, so a label with a comma or a
// quote in it is quoted to stay one.
function csv(value: string): string {
  return /[",\n\r]|^\s|\s$/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

const GhPullRequestBodySchema = z.object({ body: z.string() });

// Puts `./<name>` back wherever the PR's body still names a staged
// file's path. Read back from GitHub, since gh only says the PR's URL.
async function restoreStagedReferences(
  cwd: string,
  url: string,
  staged: readonly { name: string; path: string }[],
): Promise<void> {
  if (staged.length === 0) return;
  const { body } = GhPullRequestBodySchema.parse(
    JSON.parse(
      await runGh(["pr", "view", url, "--json", "body"], {
        cwd,
        fallback: "gh pr view failed",
      }),
    ),
  );
  let restored = body;
  for (const { name, path } of staged) {
    restored = restored.replaceAll(path, `./${name}`);
  }
  if (restored === body) return;
  await runGh(["pr", "edit", url, `--body=${restored}`], {
    cwd,
    fallback: "gh pr edit failed",
  });
}

// The PR's URL among what gh printed, its last line that is one, or
// empty when none is.
function pullRequestUrlOf(output: string): string {
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .findLast((line) => PULL_REQUEST_URL.test(line)) ?? ""
  );
}
