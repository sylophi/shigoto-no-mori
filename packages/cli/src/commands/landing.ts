// The finish line, over the engine's Landing: pr opens a worktree's pull
// request, merge merges it (arming auto-merge, or letting a queue take
// it, and waiting for GitHub to merge it), land merges and cleans up, done puts a checkout back on the primary branch,
// and rm --stack cleans up a landed stack. The engine answers each with
// the --json document the Go sm printed, which a person's lines are read from.
import { cdHintFor, cdNote, removeFlags } from "../removal.ts";
import {
  type MergeMethod,
  MergeMethodSchema,
} from "@shigomori/contracts/schemas/pullRequest";
import { execFile } from "node:child_process";
import * as Landing from "@shigomori/engine/Landing";
import * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import { changing, refuseUnmigrated } from "../engine.ts";
import { childEnv } from "@shigomori/engine/processes";
import * as Flag from "effect/cli/Flag";
import { ExitCode, UsageError } from "../errors.ts";
import {
  given,
  resolveProject,
  resolveWorktree,
  rest,
  worktreeFlags,
} from "../here.ts";
import { emit, note, out, Output, styles } from "../output.ts";
import { reporter } from "../reporter.ts";

type Doc = Landing.Document;

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

const isMethod = Schema.is(MergeMethodSchema);

const methodFlag = Flag.String("method").pipe(
  Flag.withAlias("m"),
  Flag.withDescription("merge, squash or rebase"),
  Flag.optional,
);

const methodOf = (flag: Option.Option<string>) => {
  const method = Option.getOrUndefined(given(flag));
  if (method === undefined || isMethod(method)) return Effect.succeed(method);
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

// The positionals it needs are read and the rest let be, as the Go sm did.
const target = {
  ...worktreeFlags,
  ref: Argument.String("worktree").pipe(Argument.optional),
  rest,
};

// A merge as a person reads it: merged, queued, or auto-merge armed.
const mergeLine = (
  outcome: {
    readonly number: number | undefined;
    readonly method: MergeMethod | undefined;
    readonly outcome: Doc["outcome"];
    readonly alreadyArmed?: boolean | undefined;
  },
  title: string,
) =>
  Effect.flatMap(Effect.service(Output), ({ stdoutColor }) => {
    const verb =
      outcome.outcome === "queued"
        ? "queued"
        : outcome.outcome === "auto-merge"
          ? outcome.alreadyArmed === true
            ? "auto-merge already enabled for"
            : "auto-merge enabled for"
          : "merged";
    return out(
      styles(stdoutColor).green(
        `${verb} PR #${String(outcome.number)} (${outcome.method ?? ""}): ${title}`,
      ),
    );
  });

const docOutcome = (doc: Doc) => ({
  number: doc.number,
  method: doc.method,
  outcome: doc.outcome,
});

// The landing reporter: the worktree events as the other verbs report
// them, each layer of a stack as it merges, the wait for GitHub to merge
// a PR that didn't on the spot (said under --json too, as Go did), and a
// land's cleanup as it goes.
const landingReporter = Effect.gen(function* () {
  const base = yield* reporter();
  const output = yield* Effect.service(Output);
  const { json, stdoutColor, stderrColor } = output;
  const { dim } = styles(stderrColor);
  const { green } = styles(stdoutColor);
  const person = (line: Effect.Effect<void, never, Output>) =>
    json ? Effect.void : line.pipe(Effect.provideService(Output, output));
  return {
    ...base,
    pending: (pr, outcome) =>
      person(mergeLine({ ...outcome, number: pr.number }, pr.title)),
    outcome: (pr, outcome) =>
      person(mergeLine({ ...outcome, number: pr.number }, pr.title)),
    waiting: (line) => note(dim(line)),
    note: (line) => person(note(dim(line))),
    merged: (event: Doc, pr: { readonly title: string }) =>
      json
        ? emit(event)
        : out(
            green(
              `merged PR #${String(event.number)} (${event.method ?? ""}): ${pr.title}`,
            ),
          ),
    landing: (pr, method) =>
      person(
        method === undefined
          ? note(dim(`PR #${pr.number} already merged: ${pr.title}`))
          : out(green(`merged PR #${pr.number} (${method}): ${pr.title}`)),
      ),
    caughtUp: ({ caughtUp, catchUpSkipped }) =>
      person(
        caughtUp !== undefined
          ? note(
              dim(
                `${caughtUp.isPrimary ? "primary checkout" : `worktree ${caughtUp.name}`} caught up (${caughtUp.ref})`,
              ),
            )
          : catchUpSkipped !== undefined
            ? note(dim(`skipped catch-up: ${catchUpSkipped}`))
            : Effect.void,
      ),
    removedOther: (removed) => person(out(green(`removed ${removed.name}`))),
  } satisfies Landing.Reporter;
});

// What a cleanup's failed document says, as Go said it.
const failureOf = (doc: Landing.Document) =>
  doc.cleanupError !== undefined
    ? Worktrees.cleanupFailureWords(doc.cleanupError)
    : [doc.error, doc.hint].filter(Boolean).join(" ");

// How land, done and rm --stack end, from the document: this checkout
// removed or put back on the primary branch. The steps before it were
// said as they happened (landingReporter).
const reportCleanup = (doc: Landing.Document, located: Worktrees.Located) =>
  Effect.gen(function* () {
    const { json, stdoutColor } = yield* Effect.service(Output);
    const { removed, worktree } = doc;
    // A shell standing in the removed folder is told where to go.
    const hint =
      removed === undefined
        ? ""
        : cdHintFor(removed.path, located.project.path);
    if (doc.ok === false) {
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
    if (worktree !== undefined) {
      const deleted = doc.deletedBranch ?? "";
      return yield* out(
        green(`${worktree.name} is now on ${worktree.branch}`) +
          (deleted === "" ? "" : dim(` (deleted branch ${deleted})`)),
      );
    }
    if (removed !== undefined) {
      yield* out(green(`removed ${removed.name}`));
      if (hint !== "") yield* cdNote("the removed worktree", hint);
    }
  });

export const pr = Command.make("pr", target, (input) =>
  Effect.gen(function* () {
    const { located } = yield* resolveWorktree(input);
    const doc = yield* (yield* Landing.Landing).pullRequest(located);
    const { json, stderrColor } = yield* Effect.service(Output);
    if (json) return yield* emit(doc);
    const url = doc.url ?? "";
    yield* Effect.callback<void, OpenFailed>((resume) => {
      execFile("open", [url], { env: childEnv(process.env) }, (error) => {
        resume(
          error === null
            ? Effect.void
            : Effect.fail(new OpenFailed({ url, problem: error.message })),
        );
      });
    });
    yield* out(
      `opened PR #${String(doc.number)} (${(doc.state ?? "").toLowerCase()}): ${doc.title ?? ""}`,
    );
    yield* note(styles(stderrColor).dim(url));
  }),
).pipe(
  Command.withDescription("Open a worktree's pull request"),
  Command.provideEffectDiscard(refuseUnmigrated),
);

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
      const landing = yield* Landing.Landing;
      const { json, binaryName, stderrColor } = yield* Effect.service(Output);
      const report = yield* landingReporter;
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
        // A person was told how it ended (landingReporter).
        if (json) yield* emit(doc);
        return;
      }
      const { located } = yield* resolveWorktree(input);
      const doc = yield* landing.merge({ located }, options, report);
      if (json) return yield* emit(doc);
      // A stack's layers were said as they merged.
      if (input.stack) return;
      yield* mergeLine(docOutcome(doc), doc.title ?? "");
      yield* note(
        styles(stderrColor).dim(
          `next: \`${binaryName} done\` (primary checkout) or \`${binaryName} rm ${located.worktree.name}\` (managed worktree)`,
        ),
      );
    }),
).pipe(
  Command.withDescription("Merge a worktree's pull request"),
  Command.provideEffectDiscard(refuseUnmigrated),
  changing,
);

export const land = Command.make(
  "land",
  { ...target, ...removeFlags, method: methodFlag, stack: stackFlag },
  (input) =>
    Effect.gen(function* () {
      const method = yield* methodOf(input.method);
      const { located } = yield* resolveWorktree(input);
      const { json, binaryName, stderrColor } = yield* Effect.service(Output);
      const doc = yield* (yield* Landing.Landing).land(
        located,
        {
          force: input.force,
          keepBranch: input.keepBranch,
          skipCleanup: input.skipCleanup,
          method,
          stack: input.stack,
        },
        yield* landingReporter,
      );
      // A stack a merge queue took: nothing to clean up yet.
      if (doc.merged === undefined && doc.outcome !== undefined) {
        if (json) return yield* emit(doc);
        yield* mergeLine(docOutcome(doc), doc.title ?? "");
        return yield* note(
          styles(stderrColor).dim(
            `nothing removed yet. Run \`${binaryName} land\` again once GitHub has merged it`,
          ),
        );
      }
      yield* reportCleanup(doc, located);
    }),
).pipe(
  Command.withDescription("Merge a worktree's pull request and clean up"),
  Command.provideEffectDiscard(refuseUnmigrated),
  changing,
);

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
      const doc = yield* (yield* Landing.Landing).done(located, {
        force: input.force,
      });
      yield* reportCleanup(doc, located);
      const skipped = doc.catchUpSkipped;
      const { json, stderrColor } = yield* Effect.service(Output);
      if (!json && skipped !== undefined) {
        yield* note(styles(stderrColor).dim(`skipped catch-up: ${skipped}`));
      }
    }),
).pipe(
  Command.withDescription("Put a checkout back on the primary branch"),
  Command.provideEffectDiscard(refuseUnmigrated),
  changing,
);

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
    const landing = yield* Landing.Landing;
    const doc = yield* landing.removeStack(
      yield* landing.planRemoveStack(located, options),
      yield* landingReporter,
    );
    yield* reportCleanup(doc, located);
  });
