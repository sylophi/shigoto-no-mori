// The finish line, over the engine's Landing: pr opens a worktree's pull
// request, merge merges it (or arms auto-merge, or queues it), land
// merges and cleans up, done puts a checkout back on the primary branch,
// and rm --stack cleans up a landed stack. The engine answers each with
// Go's --json document, which a person's lines are read from.
import { execFile } from "node:child_process";
import type * as Landing from "@shigomori/engine/Landing";
import * as LandingService from "@shigomori/engine/Landing";
import type * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { ExitCode, UsageError } from "../errors.ts";
import {
  cwdInside,
  given,
  resolveProject,
  resolveWorktree,
  worktreeFlags,
} from "../here.ts";
import { emit, note, out, Output, styles } from "../output.ts";
import { reporter } from "../reporter.ts";

type Doc = Readonly<Record<string, unknown>>;

// A cleanup that failed after the merge, whose document said why.
class CleanupDidNotFinish extends Schema.TaggedError<CleanupDidNotFinish>()(
  "CleanupDidNotFinish",
  { problem: Schema.String },
) {
  override get message(): string {
    return this.problem;
  }
}

class OpenFailed extends Schema.TaggedError<OpenFailed>()("OpenFailed", {
  url: Schema.String,
  problem: Schema.String,
}) {
  override get message(): string {
    return `Couldn't open ${this.url}: ${this.problem}`;
  }
}

const METHODS = ["merge", "squash", "rebase"] as const;
type Method = (typeof METHODS)[number];

const methodFlag = Flag.String("method").pipe(
  Flag.withAlias("m"),
  Flag.withDescription("merge, squash or rebase"),
  Flag.optional,
);

const methodOf = (flag: Option.Option<string>) => {
  const method = Option.getOrUndefined(given(flag));
  if (
    method === undefined ||
    (METHODS as ReadonlyArray<string>).includes(method)
  ) {
    return Effect.succeed(method as Method | undefined);
  }
  return Effect.fail(
    new UsageError({
      problem: `Invalid --method ${JSON.stringify(method)} (merge, squash, or rebase).`,
    }),
  );
};

const stackFlag = Flag.Boolean("stack").pipe(
  Flag.withDescription("Every open pull request under it too, bottom first"),
  Flag.withDefault(false),
);

const removeFlags = {
  force: Flag.Boolean("force").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Remove with uncommitted changes"),
    Flag.withDefault(false),
  ),
  keepBranch: Flag.Boolean("keep-branch").pipe(
    Flag.withDescription("Keep the branch"),
    Flag.withDefault(false),
  ),
  skipCleanup: Flag.Boolean("skip-cleanup").pipe(
    Flag.withDescription("Skip the teardown and port release"),
    Flag.withDefault(false),
  ),
};

// Go reads the positionals it needs and lets the rest be.
const target = {
  ...worktreeFlags,
  ref: Argument.String("worktree").pipe(Argument.optional),
  rest: Argument.String("args").pipe(Argument.variadic()),
};

const text = (value: unknown) => (typeof value === "string" ? value : "");

// A merge as a person reads it: merged, queued, or auto-merge armed.
const mergeLine = (doc: Doc, title: string) =>
  Effect.flatMap(Effect.service(Output), ({ stdoutColor }) => {
    const verb =
      doc["outcome"] === "queued"
        ? "queued"
        : doc["outcome"] === "auto-merge"
          ? "auto-merge enabled for"
          : "merged";
    return out(
      styles(stdoutColor).green(
        `${verb} PR #${String(doc["number"])} (${text(doc["method"])}): ${title}`,
      ),
    );
  });

// The landing reporter: the worktree events as the other verbs report
// them, and each layer of a stack as it merges.
const landingReporter = (title: { current: string }) =>
  Effect.gen(function* () {
    const base = yield* reporter();
    const { json, stdoutColor } = yield* Effect.service(Output);
    return {
      ...base,
      merged: (event: Doc, pr: { readonly title: string }) =>
        json
          ? emit(event)
          : out(
              styles(stdoutColor).green(
                `merged PR #${String(event["number"])} (${text(event["method"])}): ${pr.title}`,
              ),
            ),
      target: (pr: { readonly title: string }) =>
        Effect.sync(() => {
          title.current = pr.title;
        }),
    } satisfies Landing.Reporter;
  });

// What a cleanup's failed document says, as Go said it.
const failureOf = (doc: Doc) => {
  const cleanup = doc["cleanupError"] as
    | { readonly phase: string; readonly exitCode: number | null }
    | undefined;
  return cleanup !== undefined
    ? `${cleanup.phase} ${cleanup.exitCode === null ? "failed to run" : `exited with code ${cleanup.exitCode}`}; worktree not removed`
    : text(doc["error"]);
};

// The cleanup half of land and rm --stack, from its document: the
// other worktrees a stack removed, the catch-up, and this checkout
// removed or put back on the primary branch.
const reportCleanup = (doc: Doc, located: Worktrees.Located) =>
  Effect.gen(function* () {
    const { json, stdoutColor, stderrColor } = yield* Effect.service(Output);
    const removed = doc["removed"] as Worktrees.Removed | undefined;
    // A shell standing in the removed folder is told where to go.
    const hint =
      removed !== undefined && cwdInside(removed.path)
        ? located.project.path
        : "";
    if (doc["ok"] === false) {
      if (json) {
        yield* emit(doc);
        return yield* new ExitCode({ code: 1 });
      }
      return yield* new CleanupDidNotFinish({ problem: failureOf(doc) });
    }
    if (json) {
      return yield* emit(hint === "" ? doc : { ...doc, cdHint: hint });
    }
    const { dim, green } = styles(stdoutColor);
    const stack = doc["stack"] as
      | { readonly removed: ReadonlyArray<Worktrees.Removed> }
      | undefined;
    for (const other of stack?.removed ?? []) {
      yield* out(green(`removed ${other.name}`));
    }
    const caught = doc["caughtUp"] as
      | {
          readonly ref: string;
          readonly name: string;
          readonly isPrimary: boolean;
        }
      | undefined;
    const quiet = styles(stderrColor).dim;
    if (caught !== undefined) {
      yield* note(
        quiet(
          `${caught.isPrimary ? "primary checkout" : `worktree ${caught.name}`} caught up (${caught.ref})`,
        ),
      );
    } else if (typeof doc["catchUpSkipped"] === "string") {
      yield* note(quiet(`skipped catch-up: ${doc["catchUpSkipped"]}`));
    }
    const worktree = doc["worktree"] as Worktrees.WorktreeRow | undefined;
    if (worktree !== undefined) {
      const deleted = text(doc["deletedBranch"]);
      return yield* out(
        green(`${worktree.name} is now on ${worktree.branch}`) +
          (deleted === "" ? "" : dim(` (deleted branch ${deleted})`)),
      );
    }
    if (removed !== undefined) {
      yield* out(green(`removed ${removed.name}`));
      if (hint !== "") {
        yield* note(
          quiet(
            `note: your shell is inside the removed worktree. Run \`cd ${hint}\``,
          ),
        );
      }
    }
  });

export const pr = Command.make("pr", target, (input) =>
  Effect.gen(function* () {
    const { located } = yield* resolveWorktree(input);
    const doc = yield* (yield* LandingService.Landing).pullRequest(located);
    const { json, stderrColor } = yield* Effect.service(Output);
    if (json) return yield* emit(doc);
    const url = text(doc["url"]);
    yield* Effect.callback<void, OpenFailed>((resume) => {
      execFile("open", [url], (error) => {
        resume(
          error === null
            ? Effect.void
            : Effect.fail(new OpenFailed({ url, problem: error.message })),
        );
      });
    });
    yield* out(
      `opened PR #${String(doc["number"])} (${text(doc["state"]).toLowerCase()}): ${text(doc["title"])}`,
    );
    yield* note(styles(stderrColor).dim(url));
  }),
).pipe(Command.withDescription("Open a worktree's pull request"));

export const merge = Command.make(
  "merge",
  {
    ...target,
    method: methodFlag,
    number: Flag.String("number").pipe(Flag.optional),
    stack: stackFlag,
  },
  (input) =>
    Effect.gen(function* () {
      const method = yield* methodOf(input.method);
      const landing = yield* LandingService.Landing;
      const { json, binaryName, stderrColor } = yield* Effect.service(Output);
      const title = { current: "" };
      const report = yield* landingReporter(title);
      const options = { method, stack: input.stack };
      const raw = Option.getOrUndefined(given(input.number));
      if (raw !== undefined) {
        const number = Number(raw);
        if (!/^\d+$/.test(raw) || number <= 0) {
          return yield* new UsageError({
            problem: `Invalid --number ${JSON.stringify(raw)}.`,
          });
        }
        const project = yield* resolveProject(input);
        const doc = yield* landing.merge({ project, number }, options, report);
        if (json) return yield* emit(doc);
        if (!input.stack) yield* mergeLine(doc, title.current);
        return;
      }
      const { located } = yield* resolveWorktree(input);
      const doc = yield* landing.merge({ located }, options, report);
      if (json) return yield* emit(doc);
      // A stack's layers were said as they merged.
      if (input.stack) return;
      yield* mergeLine(doc, text(doc["title"]));
      const cleanup = `\`${binaryName} done\` (primary checkout) or \`${binaryName} rm ${located.worktree.name}\` (managed worktree)`;
      yield* note(
        styles(stderrColor).dim(
          doc["outcome"] === "auto-merge"
            ? `GitHub merges it once its requirements are met; then ${cleanup}`
            : doc["outcome"] === "queued"
              ? `the merge queue lands it; then ${cleanup}`
              : `next: ${cleanup}`,
        ),
      );
    }),
).pipe(Command.withDescription("Merge a worktree's pull request"));

export const land = Command.make(
  "land",
  { ...target, ...removeFlags, method: methodFlag, stack: stackFlag },
  (input) =>
    Effect.gen(function* () {
      const method = yield* methodOf(input.method);
      const { located } = yield* resolveWorktree(input);
      const { json, binaryName, stdoutColor, stderrColor } =
        yield* Effect.service(Output);
      const doc = yield* (yield* LandingService.Landing).land(
        located,
        {
          force: input.force,
          keepBranch: input.keepBranch,
          skipCleanup: input.skipCleanup,
          method,
          stack: input.stack,
        },
        yield* landingReporter({ current: "" }),
      );
      const merged = doc["merged"] as Doc | undefined;
      // Merged on GitHub's own time: nothing to clean up yet.
      if (merged === undefined && doc["outcome"] !== undefined) {
        if (json) return yield* emit(doc);
        yield* mergeLine(doc, text(doc["title"]));
        return yield* note(
          styles(stderrColor).dim(
            `nothing removed yet. Run \`${binaryName} land\` again once GitHub has merged it`,
          ),
        );
      }
      if (!json && merged !== undefined) {
        if (merged["alreadyMerged"] === true) {
          yield* note(
            styles(stderrColor).dim(
              `PR #${String(merged["number"])} already merged: ${text(merged["title"])}`,
            ),
          );
        } else if (!input.stack) {
          // A stack's layers were said as they merged.
          yield* out(
            styles(stdoutColor).green(
              `merged PR #${String(merged["number"])} (${text(merged["method"])}): ${text(merged["title"])}`,
            ),
          );
        }
      }
      yield* reportCleanup(doc, located);
    }),
).pipe(Command.withDescription("Merge a worktree's pull request and clean up"));

export const done = Command.make(
  "done",
  {
    ...target,
    force: Flag.Boolean("force").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Discard a branch that isn't merged"),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const { located } = yield* resolveWorktree(input);
      const doc = yield* (yield* LandingService.Landing).done(located, {
        force: input.force,
      });
      yield* reportCleanup(doc, located);
    }),
).pipe(Command.withDescription("Put a checkout back on the primary branch"));

// rm --stack: the cleanup half of a stack land.
export const removeStack = (
  located: Worktrees.Located,
  options: {
    readonly force: boolean;
    readonly keepBranch: boolean;
    readonly skipCleanup: boolean;
  },
) =>
  Effect.gen(function* () {
    const doc = yield* (yield* LandingService.Landing).removeStack(
      located,
      options,
      yield* reporter(),
    );
    yield* reportCleanup(doc, located);
  });
