// What the Git service reads out of git's output: pure functions over
// the text one command printed.
import type {
  BranchList,
  ChangeCounts,
  ChangedFile,
  ChangeKind,
  CommitSummary,
  StagedState,
} from "@shigomori/contracts/schemas";
import { isCommitHash } from "@shigomori/contracts/schemas";

// For `-z` output: NUL-separated records, with a trailing NUL that
// would otherwise yield a phantom empty entry.
export const splitZ = (stdout: string): string[] =>
  stdout.split("\0").filter((entry) => entry.length > 0);

// The subcommand of a git argv: its first argument that is not a
// global option (`-c key=value`, `-C dir`, `--no-pager`).
export function subcommandOf(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "-c" || arg === "-C") i++;
    else if (!arg.startsWith("-")) return arg;
  }
  return "";
}

// Non-empty trimmed lines.
export const splitLines = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

// --- worktree list --------------------------------------------------

// One checkout as `git worktree list --porcelain` lists it. `branch` is
// fully qualified (refs/heads/x), empty when detached or unknown.
export type WorktreeEntry = {
  readonly path: string;
  readonly head: string;
  readonly branch: string;
  readonly bare: boolean;
  readonly detached: boolean;
  // `git worktree lock`ed: git keeps its metadata even while the
  // directory is missing (a checkout on a drive that isn't mounted).
  readonly locked: boolean;
};

const blankEntry = () => ({
  path: "",
  head: "",
  branch: "",
  bare: false,
  detached: false,
  locked: false,
});

export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current = blankEntry();
  const flush = () => {
    if (current.path !== "") entries.push(current);
    current = blankEntry();
  };
  for (const line of stdout.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (key === "worktree") current.path = value;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
    else if (key === "locked") current.locked = true;
  }
  flush();
  return entries;
}

// --- status -------------------------------------------------------------

// Porcelain v2 puts a fixed number of space-separated fields before the
// path. With -z the path itself is raw, spaces included, so it is
// whatever follows the Nth space.
function afterNthSpace(record: string, n: number): string {
  let index = -1;
  for (let i = 0; i < n; i++) {
    index = record.indexOf(" ", index + 1);
    if (index < 0) return "";
  }
  return record.slice(index + 1);
}

function stagedOf(x: string, y: string): StagedState {
  if (x === ".") return "none";
  return y === "." ? "all" : "partial";
}

// x is index vs HEAD and y is worktree vs index, and they can differ
// ("AM": added to the index, edited since). Whichever side says the
// file arrived or left wins. The other side is an edit on top of that.
function kindOf(x: string, y: string): ChangeKind {
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

// `git status --porcelain=v2 -z`, one file per entry, sorted by path.
// A rename's original path follows its record as a field of its own.
export function parseStatus(stdout: string): ChangedFile[] {
  const fields = splitZ(stdout);
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i] ?? "";
    const x = record[2] ?? ".";
    const y = record[3] ?? ".";
    switch (record[0]) {
      case "?":
        files.push({ path: record.slice(2), kind: "added", staged: "none" });
        break;
      case "1":
        files.push({
          path: afterNthSpace(record, 8),
          kind: kindOf(x, y),
          staged: stagedOf(x, y),
        });
        break;
      case "2":
        files.push({
          path: afterNthSpace(record, 9),
          kind: "renamed",
          prevPath: fields[++i],
          staged: stagedOf(x, y),
        });
        break;
      case "u":
        // Both sides of an unmerged path have content. What it needs is
        // resolving, and `conflicted` says so.
        files.push({
          path: afterNthSpace(record, 10),
          kind: "modified",
          staged: "none",
          conflicted: true,
        });
        break;
      // "!" (ignored) only appears with --ignored, and "#" headers only
      // with --branch. Anything else is skipped rather than guessed at.
    }
  }
  return files.toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

// `--numstat -z` records are "<adds>\t<dels>\t<path>", except a rename
// leaves the path slot empty and spends two more fields on the old and
// new names. Binary files report "-" for both and map to undefined, so
// a caller can tell "git says no counts" from "git never mentioned it".
export function parseNumstat(
  stdout: string,
): Map<string, ChangeCounts | undefined> {
  const fields = splitZ(stdout);
  const counts = new Map<string, ChangeCounts | undefined>();
  for (let i = 0; i < fields.length; i++) {
    const [adds = "", dels = "", path = ""] = (fields[i] ?? "").split("\t");
    const name = path === "" ? (fields[i + 2] ?? "") : path;
    if (path === "") i += 2;
    if (name === "") continue;
    const additions = Number.parseInt(adds, 10);
    const deletions = Number.parseInt(dels, 10);
    counts.set(
      name,
      Number.isFinite(additions) && Number.isFinite(deletions)
        ? { additions, deletions }
        : undefined,
    );
  }
  return counts;
}

// `rev-list --left-right --count HEAD...<ref>` prints "<left>\t<right>":
// commits only on HEAD, then commits only on the ref.
export function parseLeftRight(
  stdout: string,
): { ahead: number; behind: number } | undefined {
  const [ahead, behind] = stdout.trim().split(/\s+/);
  if (ahead === undefined || behind === undefined) return undefined;
  return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
}

// --- log --------------------------------------------------------------

// `--shortstat` appends " N files changed, X insertions(+), Y deletions(-)"
// on its own line after each commit's formatted output. A SOH (\x01)
// sentinel opens each record, and NUL separates its fields, since an
// author name can hold a tab. Held to app/shared/fixtures/git-log.json,
// as the CLI's parser is.
const LOG_SENTINEL = "\x01";
export const LOG_FORMAT = `${LOG_SENTINEL}%h%x00%an%x00%aI%x00%s`;

export function parseLog(stdout: string): CommitSummary[] {
  // A record only opens at a sentinel that starts a line. Git emits a raw
  // SOH from `%s`, but it folds a subject's newlines into spaces, so a
  // subject carrying one stays inside its own header line rather than
  // opening a record of its own. Anything else on a line belongs to the
  // open record's `--shortstat` tail.
  const records: { header: string; stats: string }[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith(LOG_SENTINEL)) {
      records.push({ header: line.slice(LOG_SENTINEL.length), stats: "" });
      continue;
    }
    const open = records.at(-1);
    if (open) open.stats += line;
  }
  const commits: CommitSummary[] = [];
  for (const { header, stats } of records) {
    const [hash, author, date, ...subject] = header.split("\0");
    // A record whose first field isn't an abbreviated sha isn't a
    // commit: drop it instead of handing on an attacker-chosen string,
    // which could reach git argv from there.
    if (!hash || !isCommitHash(hash)) continue;
    const insertions = /(\d+) insertions?\(\+\)/.exec(stats);
    const deletions = /(\d+) deletions?\(-\)/.exec(stats);
    commits.push({
      hash,
      author: author ?? "",
      date: date ?? "",
      subject: subject.join("\0"),
      additions: insertions ? Number(insertions[1]) : 0,
      deletions: deletions ? Number(deletions[1]) : 0,
    });
  }
  return commits;
}

// --- refs and remotes -------------------------------------------------

// Every local and remote branch from one
// `for-each-ref --format=%(refname) %(symref) refs/heads refs/remotes`,
// so each existence check after it happens in memory.
export type BranchRefs = {
  // Short names, in ref order.
  readonly locals: readonly string[];
  // "origin/main", in ref order, without the remotes' HEAD symrefs.
  readonly remotes: readonly string[];
  // refs/remotes/<remote>/HEAD symrefs, by remote, as their fully
  // qualified targets.
  readonly remoteHeads: ReadonlyMap<string, string>;
};

export function parseBranchRefs(stdout: string): BranchRefs {
  const locals: string[] = [];
  const remotes: string[] = [];
  const remoteHeads = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [ref, symref] = line.trim().split(/\s+/);
    if (!ref) continue;
    if (ref.startsWith("refs/heads/")) {
      locals.push(ref.slice("refs/heads/".length));
    } else if (ref.startsWith("refs/remotes/")) {
      const short = ref.slice("refs/remotes/".length);
      if (short.endsWith("/HEAD") && symref) {
        remoteHeads.set(short.slice(0, -"/HEAD".length), symref);
        continue;
      }
      remotes.push(short);
    }
  }
  return { locals, remotes, remoteHeads };
}

// The branch lists a base-ref picker offers.
export const branchListOf = (refs: BranchRefs): BranchList => ({
  local: [...refs.locals],
  remote: [...refs.remotes],
});

// Upstream first, then origin, then the rest alphabetically: the
// precedence repo identity's remote rule applies too, so the default
// ref and the identity key off the same canonical remote.
export function orderRemotesByPrecedence(remotes: readonly string[]): string[] {
  const preferred = ["upstream", "origin"].filter((name) =>
    remotes.includes(name),
  );
  const rest = remotes
    .filter((name) => name !== "upstream" && name !== "origin")
    .toSorted();
  return [...preferred, ...rest];
}

// Named for the user where a repo has no identity, so a change here
// changes that sentence.
const DEFAULT_BRANCH_CANDIDATES = ["main", "master", "dev"] as const;

// The fully qualified default ref, or undefined for none: a valid
// override wins, then each candidate remote-first in the remotes'
// precedence, and last a remote's own HEAD (the symref a clone copies
// from the server's default branch). Without a first-local-branch
// fallback, since repo identity keys off this and "whichever branch
// this device has first" must never key one. The remote HEAD comes
// after the candidates because merge targets resolve here too: a repo
// with origin/HEAD -> trunk and a stale local main keeps merging into
// main.
export function pickDefaultRef(
  refs: BranchRefs,
  override: string | undefined,
  remotes: readonly string[],
): string | undefined {
  const trimmed = override?.trim();
  if (trimmed) {
    if (refs.locals.includes(trimmed)) return `refs/heads/${trimmed}`;
    if (refs.remotes.includes(trimmed)) return `refs/remotes/${trimmed}`;
  }
  const ordered = orderRemotesByPrecedence(remotes);
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    for (const remote of ordered) {
      const ref = `${remote}/${candidate}`;
      if (refs.remotes.includes(ref)) return `refs/remotes/${ref}`;
    }
    if (refs.locals.includes(candidate)) return `refs/heads/${candidate}`;
  }
  for (const remote of ordered) {
    // Only a symref to a branch that exists: a clone whose server-side
    // default was later renamed keeps a dangling one.
    const target = refs.remoteHeads.get(remote);
    if (
      target?.startsWith("refs/remotes/") &&
      refs.remotes.includes(target.slice("refs/remotes/".length))
    ) {
      return target;
    }
  }
  return undefined;
}

// pickDefaultRef only yields these two namespaces, so the strip
// recovers exactly the short names ("main", "origin/main").
export const shortRefName = (fullRef: string): string =>
  fullRef.startsWith("refs/heads/")
    ? fullRef.slice("refs/heads/".length)
    : fullRef.replace(/^refs\/remotes\//, "");

// Splits a remote-tracking ref like "origin/main" or "fork/feat/x" into
// remote and branch, by the longest configured remote that prefixes it,
// so a remote named "origin/foo" wins over "origin" for "origin/foo/bar".
export function splitRemoteRef(
  ref: string,
  remotes: readonly string[],
): { readonly remote: string; readonly branch: string } | undefined {
  let best: { remote: string; branch: string } | undefined;
  for (const remote of remotes) {
    if (
      ref.startsWith(`${remote}/`) &&
      (!best || remote.length > best.remote.length)
    ) {
      best = { remote, branch: ref.slice(remote.length + 1) };
    }
  }
  return best;
}

// Every row of `git remote -v` as a name and URL, fetch and push both
// (a remote can push somewhere other than it fetches), deduped.
export function parseRemoteEntries(
  stdout: string,
): { name: string; url: string }[] {
  const entries: { name: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /^(\S+)\s+(\S+)\s+\(/.exec(line);
    const name = match?.[1];
    const url = match?.[2];
    if (!name || !url || seen.has(`${name}\t${url}`)) continue;
    seen.add(`${name}\t${url}`);
    entries.push({ name, url });
  }
  return entries;
}

// --- ignore rules -----------------------------------------------------

// A .gitignore's rules, comments and blank lines dropped.
export const ignoreRulesOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && !line.startsWith("#"));

// A nested .gitignore's rule as a root-relative pattern. A slash
// anywhere but the end pins the rule to its folder, and a bare name
// (or name/) matches at any depth below it, as git reads them.
export function anchorRule(rule: string, folder: string): string {
  if (folder === "") return rule;
  const negated = rule.startsWith("!");
  const body = negated ? rule.slice(1) : rule;
  const pinned = body.startsWith("/") || body.slice(0, -1).includes("/");
  const anchored = pinned
    ? `/${folder}/${body.replace(/^\//, "")}`
    : `/${folder}/**/${body}`;
  return negated ? `!${anchored}` : anchored;
}

// A path as a gitignore pattern that matches that name and nothing
// else: backslashes and the pattern characters escaped, and trailing
// spaces, which git would strip, kept.
export function escapeGitignorePattern(path: string): string {
  const escaped = path.replaceAll("\\", "\\\\").replace(/([*?[\]#!])/g, "\\$1");
  const trimmed = escaped.replace(/ +$/, "");
  return trimmed + "\\ ".repeat(escaped.length - trimmed.length);
}
