// The finish line, over the engine's Landing: pr opens a worktree's
// pull request, merge merges it (arming auto-merge, or letting a queue
// take it, and waiting for GitHub to merge it), land merges and cleans
// up, done puts a checkout back on the primary branch, and rm --stack
// cleans up a landed stack. The engine answers each with what it did,
// which a person's lines are read from, and renders its --json document.
import { cdHintFor, cdNote, removeFlags } from "../removal.ts";
import {
  type MergeMethod,
  MergeMethodSchema,
} from "@shigomori/contracts/schemas/pullRequest";
import { execFile } from "node:child_process";
import * as Landing from "@shigomori/engine/Landing";
import type * as Worktrees from "@shigomori/engine/Worktrees";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Argument from "effect/cli/Argument";
import * as Command from "effect/cli/Command";
import { changing, refuseUnmigrated } from "../engine.ts";
import { childEnv } from "@shigomori/engine/processes";
import { screenOpener } from "@shigomori/engine/screen";
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

const stackFlag = Flag.Boolean("stack").pipe(Flag.withDefault(false));

// The positionals it needs are read and the rest let be.
const target = {
  ...worktreeFlags,
  ref: Argument.String("worktree").pipe(Argument.optional),
  rest,
};

// A merge as a person reads it: merged, queued, or auto-merge armed.
const mergeLine = (
  outcome: {
    readonly number: number;
    readonly method: MergeMethod;
    readonly outcome: Landing.Merged["outcome"];
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
        `${verb} PR #${outcome.number} (${outcome.method}): ${title}`,
      ),
    );
  });

// The landing reporter: the worktree events as the other verbs report
// them, each layer of a stack as it merges, the wait for GitHub to
// merge a PR that didn't on the spot (said under --json too), and a
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
    merged: (pr, method) =>
      json
        ? emit(Landing.mergedEvent(pr, method))
        : out(green(`merged PR #${pr.number} (${method}): ${pr.title}`)),
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

// A checkout put back on the primary branch.
const reportDone = (done: Landing.Done) =>
  Effect.flatMap(Effect.service(Output), ({ stdoutColor }) => {
    const { dim, green } = styles(stdoutColor);
    const deleted = done.deletedBranch;
    return out(
      green(`${done.worktree.name} is now on ${done.worktree.branch}`) +
        (deleted === undefined ? "" : dim(` (deleted branch ${deleted})`)),
    );
  });

// How land and rm --stack end: this checkout removed or put back on the
// primary branch, or the document `render` makes under --json. The steps
// before it were said as they happened (landingReporter).
const reportCleanup = (
  cleanup: Landing.Cleanup,
  located: Worktrees.Located,
  render: () => object,
) =>
  Effect.gen(function* () {
    const { json, stdoutColor } = yield* Effect.service(Output);
    switch (cleanup.kind) {
      case "done":
        return yield* json ? emit(render()) : reportDone(cleanup.done);
      case "failed":
        if (!json) return yield* cleanup.error;
        yield* emit(render());
        return yield* new ExitCode({ code: 1 });
      case "removed": {
        const { removed } = cleanup;
        // A shell standing in the removed folder is told where to go.
        const hint = cdHintFor(removed.path, located.project.path);
        if (json) {
          return yield* emit(
            hint === "" ? render() : { ...render(), cdHint: hint },
          );
        }
        yield* out(styles(stdoutColor).green(`removed ${removed.name}`));
        if (hint !== "") yield* cdNote("the removed worktree", hint);
      }
    }
  });

export const pr = Command.make("pr", target, (input) =>
  Effect.gen(function* () {
    const { located } = yield* resolveWorktree(input);
    const found = yield* (yield* Landing.Landing).pullRequest(located);
    const { json, stderrColor } = yield* Effect.service(Output);
    if (json) return yield* emit(Landing.pullRequestDocument(found));
    const { url, number, state, title } = found.pr;
    // Where there's no screen to open it on, the link is what it gets.
    const opener = yield* screenOpener;
    if (Option.isSome(opener)) {
      yield* Effect.callback<void, OpenFailed>((resume) => {
        execFile(
          opener.value.program,
          [...opener.value.args, url],
          { env: childEnv(process.env) },
          (error) => {
            resume(
              error === null
                ? Effect.void
                : Effect.fail(new OpenFailed({ url, problem: error.message })),
            );
          },
        );
      });
    }
    yield* out(
      `${Option.isSome(opener) ? "opened " : ""}PR #${number} (${state.toLowerCase()}): ${title}`,
    );
    yield* note(styles(stderrColor).dim(url));
  }),
).pipe(Command.provideEffectDiscard(refuseUnmigrated));

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
        const merged = yield* landing.merge(
          { project, number },
          options,
          report,
        );
        // A person was told how it ended (landingReporter).
        if (json) yield* emit(Landing.mergeDocument(merged));
        return;
      }
      const { located } = yield* resolveWorktree(input);
      const merged = yield* landing.merge({ located }, options, report);
      if (json) return yield* emit(Landing.mergeDocument(merged));
      // A stack's layers were said as they merged.
      if (merged.kind !== "branch") return;
      yield* mergeLine(
        { ...merged, number: merged.pr.number },
        merged.pr.title,
      );
      yield* note(
        styles(stderrColor).dim(
          `next: \`${binaryName} done\` (primary checkout) or \`${binaryName} rm ${located.worktree.name}\` (managed worktree)`,
        ),
      );
    }),
).pipe(Command.provideEffectDiscard(refuseUnmigrated), changing);

export const land = Command.make(
  "land",
  { ...target, ...removeFlags, method: methodFlag, stack: stackFlag },
  (input) =>
    Effect.gen(function* () {
      const method = yield* methodOf(input.method);
      const { located } = yield* resolveWorktree(input);
      const { json, binaryName, stderrColor } = yield* Effect.service(Output);
      const landed = yield* (yield* Landing.Landing).land(
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
      if (landed.kind === "queued") {
        if (json) return yield* emit(Landing.landDocument(landed));
        yield* mergeLine(
          {
            number: landed.pr.number,
            method: landed.method,
            outcome: "queued",
          },
          landed.pr.title,
        );
        return yield* note(
          styles(stderrColor).dim(
            `nothing removed yet. Run \`${binaryName} land\` again once GitHub has merged it`,
          ),
        );
      }
      yield* reportCleanup(landed.cleanup, located, () =>
        Landing.landDocument(landed),
      );
    }),
).pipe(Command.provideEffectDiscard(refuseUnmigrated), changing);

export const done = Command.make(
  "done",
  {
    ...target,
    force: Flag.Boolean("force").pipe(
      Flag.withAlias("f"),
      Flag.withDefault(false),
    ),
  },
  (input) =>
    Effect.gen(function* () {
      const { located } = yield* resolveWorktree(input);
      const finished = yield* (yield* Landing.Landing).done(located, {
        force: input.force,
      });
      const { json, stderrColor } = yield* Effect.service(Output);
      if (json) return yield* emit(Landing.doneDocument(finished));
      yield* reportDone(finished);
      const skipped = finished.catchUpSkipped;
      if (skipped !== undefined) {
        yield* note(styles(stderrColor).dim(`skipped catch-up: ${skipped}`));
      }
    }),
).pipe(Command.provideEffectDiscard(refuseUnmigrated), changing);

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
    const cleanup = yield* landing.removeStack(
      yield* landing.planRemoveStack(located, options),
      yield* landingReporter,
    );
    yield* reportCleanup(cleanup, located, () =>
      Landing.removeStackDocument(cleanup),
    );
  });
