// The create pull request dialog's host side: where it starts (the base a
// stacked branch belongs on, gh's --fill, the repo's template), what a
// PR into a base would hold, who and what it can name, the files pasted
// into its description, and the create itself.
import { isIPv4, isIPv6 } from "node:net";
import { join } from "node:path";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  type CreatePullRequestResult,
  isFromThisRepository,
  type PullRequestCompare,
  type PullRequestDraft,
  type StagedAttachment,
} from "@shigomori/contracts/schemas";
import {
  attachmentExtension,
  attachmentReference,
  attachmentRefusal,
  attachmentTypeOfName,
} from "@shigomori/contracts/attachments";
import {
  orderRemotesByPrecedence,
  parseNumstat,
} from "@shigomori/engine/gitParse";
import * as Git from "@shigomori/engine/Git";
import * as Paths from "@shigomori/engine/Paths";
import { GhActionError, ghReady, ghStream, runGh } from "./actions";
import { GithubCli } from "./GithubCli";
import * as PullRequestMaps from "./PullRequestMaps";

// git as the engine runs it, strictly and leniently.
const run = (cwd: string, args: readonly string[]) =>
  Effect.flatMap(Git.Git, (git) => git.run(cwd, args));
const runLenient = (cwd: string, args: readonly string[]) =>
  Effect.flatMap(Git.Git, (git) => git.runLenient(cwd, args));

// Every local branch and remote-tracking ref by its full name, or only
// those whose tip `mergedInto` reaches.
const refNames = (cwd: string, mergedInto?: string) =>
  Effect.map(
    run(cwd, [
      "for-each-ref",
      "--format=%(refname)",
      ...(mergedInto ? [`--merged=${mergedInto}`] : []),
      "refs/heads/",
      "refs/remotes/",
    ]),
    (out) => new Set(out.split("\n").filter(Boolean)),
  );

// The ref a branch is compared at: its remote-tracking ref, which is
// what GitHub holds and the PR merges into, in the remotes' precedence
// (upstream, origin, the rest), else the local branch. Null when
// neither exists. Built from full names, so no branch name can read as
// a flag or a revision expression.
function trackedRef(
  branch: string,
  refs: ReadonlySet<string>,
  remotes: readonly string[],
): string | null {
  for (const remote of remotes) {
    const ref = `refs/remotes/${remote}/${branch}`;
    if (refs.has(ref)) return ref;
  }
  const local = `refs/heads/${branch}`;
  return refs.has(local) ? local : null;
}

const orderedRemotes = (cwd: string) =>
  Effect.map(
    Effect.flatMap(Git.Git, (git) => git.listRemotes(cwd)),
    orderRemotesByPrecedence,
  );

// The worktree a draft is read for: its checkout, its project's, the
// branch it has out and the project's primary ref.
interface DraftSource {
  cwd: string;
  project: PullRequestMaps.ProjectRef;
  branch: string;
  primaryRef: string | undefined;
}

export const getPullRequestDraft = Effect.fn("NewPullRequest.draft")(function* (
  opts: DraftSource,
) {
  const { cwd, primaryRef } = opts;
  const [stack, template] = yield* Effect.all(
    [stackBase(opts), readPullRequestTemplate(cwd)],
    { concurrency: 2 },
  );
  const fillBase = stack?.ref ?? primaryRef;
  return {
    suggestedBase: stack?.branch ?? null,
    fill: fillBase
      ? yield* fillFrom(cwd, fillBase, opts.branch)
      : { title: "", body: "" },
    template,
  } satisfies PullRequestDraft;
});

// The branch a stacked branch belongs on: of the open PRs from this
// repository, the head nearest below HEAD. A head HEAD sits on exactly
// would make an empty PR, and one the primary branch already holds is
// no step above it, so neither counts.
const stackBase = Effect.fnUntraced(function* (opts: DraftSource) {
  const { cwd, primaryRef } = opts;
  const prs = yield* (yield* PullRequestMaps.PullRequestMaps).get(opts.project);
  const heads = [...prs].flatMap(([head, pr]) =>
    head !== opts.branch && pr.state === "OPEN" && isFromThisRepository(pr)
      ? [head]
      : [],
  );
  if (heads.length === 0) return null;
  const [refs, below, landed, remotes] = yield* Effect.all(
    [
      refNames(cwd),
      refNames(cwd, "HEAD"),
      primaryRef
        ? refNames(cwd, primaryRef)
        : Effect.succeed(new Set<string>()),
      orderedRemotes(cwd),
    ],
    { concurrency: "unbounded" },
  );
  const candidates = heads.flatMap((branch) => {
    const ref = trackedRef(branch, refs, remotes);
    return ref && below.has(ref) && !landed.has(ref) ? [{ branch, ref }] : [];
  });
  const distances = yield* Effect.forEach(
    candidates,
    ({ ref }) =>
      Effect.flatMap(Git.Git, (git) => git.countCommits(cwd, [`${ref}..HEAD`])),
    { concurrency: "unbounded" },
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
});

// What `gh pr create --fill` writes (initDefaultTitleBody in gh's
// pkg/cmd/pr/create/create.go), from the same commits: HEAD's side of
// `base...HEAD` without merges or ones the base already has a copy of.
// One commit gives its own message. Several give the branch name with
// its dashes and underscores made spaces (gh's humanize, which changes
// nothing else), and a list of their subjects, oldest first. gh ends
// either with a newline, which a text box only shows as a stray line.
const fillFrom = Effect.fnUntraced(function* (
  cwd: string,
  base: string,
  branch: string,
) {
  const out = yield* run(cwd, [
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
});

// gh's own lookup for the single template (FindLegacy in its
// pkg/githubtemplate), which GitHub also fills a new PR with: the first
// file, by name, in .github, the root, then docs, named
// pull_request_template with any extension and either case, a dash for
// either underscore allowed. A PULL_REQUEST_TEMPLATE folder holds a
// choice of several, which is left to GitHub's own page. Symlinks are
// skipped as gh skips them.
const TEMPLATE_NAME = /^pull[_-]request[_-]template(\.|$)/i;

const readPullRequestTemplate = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const found = yield* Effect.forEach(
    [".github", ".", "docs"],
    (dir) =>
      Effect.gen(function* () {
        const names = yield* fs
          .readDirectory(join(cwd, dir))
          .pipe(Effect.orElseSucceed((): string[] => []));
        // Read without following a link: a link is skipped, as gh skips
        // one, whatever it points at.
        const files = yield* Effect.forEach(
          names.filter((name) => TEMPLATE_NAME.test(name)),
          (name) => {
            const path = join(cwd, dir, name);
            return fs.readLink(path).pipe(
              Effect.as(null),
              Effect.catch(() =>
                fs.stat(path).pipe(
                  Effect.map((info) => (info.type === "File" ? name : null)),
                  Effect.orElseSucceed(() => null),
                ),
              ),
            );
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.map((all) => all.filter((name) => name !== null)));
        const file = files.toSorted()[0];
        return file === undefined ? null : join(cwd, dir, file);
      }),
    { concurrency: "unbounded" },
  );
  const template = found.find((path) => path !== null);
  return template ? yield* fs.readFileString(template) : null;
});

// How many commits the branch has since it left `base`, and what they
// change together, as GitHub's compare would count them.
export const comparePullRequest = Effect.fn("NewPullRequest.compare")(
  function* (cwd: string, base: string) {
    const [refs, remotes] = yield* Effect.all(
      [refNames(cwd), orderedRemotes(cwd)],
      { concurrency: 2 },
    );
    const ref = trackedRef(base, refs, remotes);
    if (!ref) {
      return yield* new Git.GitRefusedError({
        reason: `There is no branch named ${base} to compare with.`,
      });
    }
    const mergeBase = (yield* runLenient(cwd, [
      "merge-base",
      "--end-of-options",
      "HEAD",
      ref,
    ])).trim();
    if (!mergeBase) {
      return yield* new Git.GitRefusedError({
        reason: `This branch shares no history with ${base}.`,
      });
    }
    const [commits, counts] = yield* Effect.all(
      [
        Effect.flatMap(Git.Git, (git) =>
          git.countCommits(cwd, [`${mergeBase}..HEAD`]),
        ),
        Effect.map(
          run(cwd, ["diff", "--numstat", "-z", mergeBase, "HEAD", "--"]),
          parseNumstat,
        ),
      ],
      { concurrency: 2 },
    );
    // A binary file has no counts: a file, with no lines to add up.
    let additions = 0;
    let deletions = 0;
    for (const count of counts.values()) {
      additions += count?.additions ?? 0;
      deletions += count?.deletions ?? 0;
    }
    return {
      commits,
      files: counts.size,
      additions,
      deletions,
    } satisfies PullRequestCompare;
  },
);

// The people and labels a new PR can name, as GithubCli keeps them,
// behind the same readiness gate as the other actions.
export const getPullRequestOptions = Effect.fn("NewPullRequest.options")(
  function* (cwd: string) {
    yield* ghReady;
    return yield* (yield* GithubCli).pullRequestOptions(cwd).pipe(
      Effect.mapError(
        (cause) =>
          new GhActionError({
            reason: "Couldn't read the repository's people and labels",
            cause,
          }),
      ),
    );
  },
);

// Pasted files wait in the data dir, which is the user's alone, one
// folder per attachment, until the PR that uploads them is created.
// GitHub takes a video of up to 100 MiB, an image of far less, so
// nothing larger is worth holding. With no id, the folder of them all.
const attachmentDir = (id = "") =>
  Effect.map(Paths.Paths, ({ dataDir }) => join(dataDir, "pr-attachments", id));

// A form left unsent keeps its files, so each new attachment clears the
// ones staged over a day ago: by then the form that held them is gone
// with the app session, or an attachment of it reads as no longer
// attached and is added again.
const STALE_ATTACHMENT = Duration.days(1);

const sweepStaleAttachments = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* attachmentDir();
  const ids = yield* fs
    .readDirectory(root)
    .pipe(Effect.orElseSucceed((): string[] => []));
  const cutoff =
    (yield* Clock.currentTimeMillis) - Duration.toMillis(STALE_ATTACHMENT);
  yield* Effect.forEach(
    ids,
    (id) =>
      Effect.gen(function* () {
        const dir = join(root, id);
        const info = yield* Effect.option(fs.stat(dir));
        const at = Option.flatMap(info, (i) => i.mtime);
        if (Option.isSome(at) && at.value.getTime() < cutoff) {
          yield* fs.remove(dir, { recursive: true, force: true });
        }
      }).pipe(Effect.ignore),
    { concurrency: "unbounded", discard: true },
  );
});

// An attachment taken out of the form.
export const discardAttachment = Effect.fn("NewPullRequest.discardAttachment")(
  function* (id: string) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(yield* attachmentDir(id), {
      recursive: true,
      force: true,
    });
  },
);

const sizeOf = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.stat(path).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => null),
    ),
  );

// Writes one chunk. The first starts the file over, and every later one
// must land where the file ends, so a chunk lost or repeated in transit
// fails the paste rather than leaving a corrupt file to upload.
export const stageAttachment = Effect.fn("NewPullRequest.stageAttachment")(
  function* (chunk: {
    readonly id: string;
    readonly name: string;
    readonly offset: number;
    readonly base64: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* attachmentDir(chunk.id);
    const path = join(dir, chunk.name);
    const bytes = Buffer.from(chunk.base64, "base64");
    // By the file's whole size so far, as the dialog checked the file.
    const refusal = attachmentRefusal({
      name: chunk.name,
      type: attachmentTypeOfName(chunk.name),
      size: chunk.offset + bytes.length,
    });
    if (refusal !== null) return yield* new GhActionError({ reason: refusal });
    if (chunk.offset === 0) {
      yield* sweepStaleAttachments;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFile(path, bytes);
      return;
    }
    if ((yield* sizeOf(path)) !== chunk.offset) {
      return yield* new GhActionError({
        reason: "Attachment chunk out of order",
      });
    }
    yield* fs.writeFile(path, bytes, { flag: "a" });
  },
);

// How long a linked image or video gets to arrive.
const FETCH_TIMEOUT = Duration.minutes(2);

// Fetches a file dropped or pasted in as a link, here rather than in the
// renderer, which a site's CORS rules would stop. It has to come as a type
// gh uploads and within its size, and is named by that type, whatever
// the URL ends in. A failed fetch leaves nothing behind.
export const stageAttachmentFromUrl = Effect.fn(
  "NewPullRequest.stageAttachmentFromUrl",
)(function* (
  source: { readonly id: string; readonly stem: string; readonly url: string },
  // A link to a private host is refused unless privateHosts is set.
  opts: { privateHosts?: boolean } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const fetched = yield* Effect.gen(function* () {
    const response = yield* fetchLink(source.url, opts.privateHosts ?? false);
    const body = response.body;
    if (!response.ok || !body) {
      return yield* new GhActionError({
        reason: `Couldn't fetch ${source.url}: HTTP ${response.status}`,
      });
    }
    const cancel = Effect.promise(() => body.cancel());
    const type =
      (response.headers.get("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase() ?? "";
    // The link's bytes so far, refused by the dialog's rule for a file.
    const refused = (size?: number) => {
      const reason = attachmentRefusal({ name: source.url, type, size });
      return reason === null ? null : new GhActionError({ reason });
    };
    // A missing or empty header says nothing of the size.
    const length = response.headers.get("content-length") || null;
    const early = refused(length === null ? undefined : Number(length));
    if (early !== null) {
      yield* cancel;
      return yield* early;
    }
    const name = `${source.stem}.${attachmentExtension(type)}`;
    yield* sweepStaleAttachments;
    const dir = yield* attachmentDir(source.id);
    yield* fs.makeDirectory(dir, { recursive: true });
    let size = 0;
    yield* Stream.fromReadableStream({
      evaluate: () => body,
      onError: (cause) =>
        new GhActionError({ reason: `Couldn't fetch ${source.url}`, cause }),
    }).pipe(
      Stream.mapEffect((bytes: Uint8Array) => {
        size += bytes.length;
        const late = refused(size);
        return late === null ? Effect.succeed(bytes) : Effect.fail(late);
      }),
      Stream.run(fs.sink(join(dir, name))),
    );
    const empty = refused(size);
    if (empty !== null) return yield* empty;
    return { name, type } satisfies StagedAttachment;
  }).pipe(
    Effect.timeoutOrElse({
      duration: FETCH_TIMEOUT,
      orElse: () =>
        Effect.fail(
          new GhActionError({ reason: `Couldn't fetch ${source.url}` }),
        ),
    }),
    Effect.tapError(() => Effect.ignore(discardAttachment(source.id))),
  );
  return fetched;
});

// A link is followed only as far as the web: one HTML from a page can
// hold, at this machine or its network (a router's snapshot, a local
// server), would be fetched from here and published on the PR. Every
// redirect is checked the same way. A name that resolves privately
// isn't caught, only one that says so.
const MAX_REDIRECTS = 5;

const fetchLink = Effect.fnUntraced(function* (
  url: string,
  privateHosts: boolean,
) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = new URL(current);
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return yield* new GhActionError({ reason: `${url} isn't on the web` });
    }
    if (!privateHosts && isPrivateHost(target.hostname)) {
      return yield* new GhActionError({
        reason: `${url} points at this machine or its network`,
      });
    }
    // One hop at a time, each checked before it's taken.
    const hopUrl = current;
    const response = yield* Effect.tryPromise({
      try: (signal) => fetch(hopUrl, { redirect: "manual", signal }),
      catch: (cause) =>
        new GhActionError({ reason: `Couldn't fetch ${url}`, cause }),
    });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      return response;
    }
    yield* Effect.promise(async () => response.body?.cancel());
    current = new URL(location, current).toString();
  }
  return yield* new GhActionError({
    reason: `${url} redirects too many times`,
  });
});

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
export const createPullRequest = Effect.fn("NewPullRequest.create")(
  function* (opts: {
    readonly cwd: string;
    readonly project: PullRequestMaps.ProjectRef;
    readonly base: string;
    readonly title: string;
    readonly body: string;
    readonly draft: boolean;
    readonly reviewers: readonly string[];
    readonly assignees: readonly string[];
    readonly labels: readonly string[];
    readonly attachments: readonly {
      readonly id: string;
      readonly name: string;
    }[];
  }) {
    const { cwd, project } = opts;
    const maps = yield* PullRequestMaps.PullRequestMaps;
    const root = yield* attachmentDir();
    const staged = opts.attachments.map(({ id, name }) => ({
      id,
      name,
      path: join(root, id, name),
    }));
    const fs = yield* FileSystem.FileSystem;
    const present = yield* Effect.forEach(
      staged,
      ({ path }) =>
        fs.stat(path).pipe(
          Effect.map((info) => info.type === "File"),
          Effect.orElseSucceed(() => false),
        ),
      { concurrency: "unbounded" },
    );
    const missing = staged.find((_, i) => !present[i]);
    if (missing) {
      return yield* new GhActionError({
        reason: `${missing.name} is no longer attached. Add it again.`,
      });
    }
    const body = pointAtStaged(opts.body, staged);

    yield* pushForPullRequest(cwd, project.path);

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
    const done = (result: CreatePullRequestResult) =>
      Effect.as(
        Effect.forEach(
          staged,
          ({ id }) => Effect.ignore(discardAttachment(id)),
          {
            concurrency: "unbounded",
            discard: true,
          },
        ),
        result,
      );
    return yield* runGh(args, {
      cwd,
      fallback: "gh pr create failed",
      timeout: CREATE_TIMEOUT_MS,
    }).pipe(
      Effect.flatMap((stdout) =>
        done({ url: pullRequestUrlOf(stdout), warning: null }),
      ),
      Effect.catchTags({
        GhActionError: (err) =>
          Effect.gen(function* () {
            // When some attachments upload and others don't, gh still
            // creates the PR with those that did, prints its URL and
            // exits non-zero. The PR exists, so that is an answer with a
            // warning beside it. A reference to one that didn't upload is
            // left as it was, holding this machine's path, which goes
            // back to the name it was written with before anyone reads
            // it.
            const url = pullRequestUrlOf(ghStream(err, "stdout"));
            if (url) {
              const unpublished = yield* restoreStagedReferences(
                cwd,
                url,
                staged,
              ).pipe(
                Effect.as(null),
                Effect.catch((restoreErr) =>
                  Effect.succeed(
                    `The description may still name a file's path on this machine. Edit it on GitHub. (${restoreErr.message})`,
                  ),
                ),
              );
              return yield* done({
                url,
                warning: [err.message, unpublished].filter(Boolean).join("\n"),
              });
            }
            // cobra prints its usage after the error, so runGh's message
            // (the last line) is the usage's and not what went wrong.
            if (ghStream(err, "stderr").includes("unknown flag: --attach")) {
              return yield* new GhActionError({
                reason: "Attaching files needs GitHub CLI 2.99 or newer.",
                cause: err,
              });
            }
            return yield* err;
          }),
      }),
      Effect.ensuring(maps.moved(project)),
    );
  },
);

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
              .replaceAll(`](${attachmentReference(name)})`, `](${path})`)
              .replaceAll(`](<${attachmentReference(name)}>)`, `](<${path}>)`);
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
const pushForPullRequest = Effect.fnUntraced(function* (
  cwd: string,
  projectPath: string,
) {
  const branch = (yield* run(cwd, ["symbolic-ref", "--short", "HEAD"])).trim();
  const config = (key: string) =>
    Effect.map(
      runLenient(cwd, ["config", "--get", `branch.${branch}.${key}`]),
      (out) => out.trim(),
    );
  const [remote, merge] = yield* Effect.all(
    [config("remote"), config("merge")],
    { concurrency: 2 },
  );
  if (remote !== "" && remote !== "." && merge === `refs/heads/${branch}`) {
    yield* run(cwd, ["push", remote, `HEAD:${merge}`]);
    return;
  }
  yield* (yield* Git.Git).publish({ worktree: cwd, repo: projectPath });
});

// gh reads a list flag's value as CSV, so a label with a comma or a
// quote in it is quoted to stay one.
function csv(value: string): string {
  return /[",\n\r]|^\s|\s$/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

const decodePullRequestBody = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ body: Schema.String })),
);

// Puts `./<name>` back wherever the PR's body still names a staged
// file's path. Read back from GitHub, since gh only says the PR's URL.
const restoreStagedReferences = Effect.fnUntraced(function* (
  cwd: string,
  url: string,
  staged: readonly { name: string; path: string }[],
) {
  if (staged.length === 0) return;
  const { body } = yield* decodePullRequestBody(
    yield* runGh(["pr", "view", url, "--json", "body"], {
      cwd,
      fallback: "gh pr view failed",
    }),
  );
  let restored = body;
  for (const { name, path } of staged) {
    restored = restored.replaceAll(path, attachmentReference(name));
  }
  if (restored === body) return;
  yield* runGh(["pr", "edit", url, `--body=${restored}`], {
    cwd,
    fallback: "gh pr edit failed",
  });
});

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
