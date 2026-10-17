// The finish line: a worktree's pull request merged on GitHub, its
// branch's checkout caught up, and the worktree cleaned up. One merge
// flow under `merge`, `land` and the app's merge button: the merge
// method picked (the flag, the project's last one, the repo's first),
// auto-merge armed where the base branch's rules aren't met yet, a stack
// landed whole. `done` lands a checkout back on the primary branch.
// Answers are the documents `sm --json` prints, and each step reported
// along the way is too.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitHub from "./GitHub.ts";
import type { MergeMethod } from "./GitHub.ts";
import type { RegisteredProject } from "./Registry.ts";
import * as Worktrees from "./Worktrees.ts";
import { makePullRequests } from "./landing/pullRequests.ts";
import { makeStacks } from "./landing/stacks.ts";
import { makeCleanup } from "./landing/cleanup.ts";
import { type StackRemoval, makeVerbs } from "./landing/verbs.ts";
import {
  type Document,
  type DoneError,
  type LandError,
  LandingRefused,
  type MergeError,
  type RemoveOptions,
  type RemoveStackError,
  type Reporter,
} from "./landing/documents.ts";
export { LandingRefused, MergePollInterval } from "./landing/documents.ts";
export type { Document, Reporter } from "./landing/documents.ts";
export type { StackRemoval } from "./landing/verbs.ts";

export class Landing extends Context.Service<
  Landing,
  {
    // `sm pr`: the worktree's pull request, any state.
    readonly pullRequest: (
      located: Worktrees.Located,
    ) => Effect.Effect<
      Document,
      LandingRefused | GitHub.GitHubCliError | GitHub.GitHubOutputError
    >;
    // `sm merge`: the worktree's open PR, or with `number` that PR of the
    // project, merged (or queued, or auto-merge armed). A PR that didn't
    // merge on the spot is waited on until GitHub merges it, except by
    // `number` (the app's merge, which shows the armed or queued PR
    // itself). `stack` merges every open PR under it too, bottom first,
    // each reported.
    readonly merge: (
      target:
        | { readonly located: Worktrees.Located }
        | { readonly project: RegisteredProject; readonly number: number },
      options: {
        readonly method?: MergeMethod | undefined;
        readonly stack: boolean;
      },
      reporter: Reporter,
    ) => Effect.Effect<Document, MergeError>;
    // `sm land`: merge, catch the base branch's checkout up, clean up.
    readonly land: (
      located: Worktrees.Located,
      options: RemoveOptions & {
        readonly method?: MergeMethod | undefined;
        readonly stack: boolean;
      },
      reporter: Reporter,
    ) => Effect.Effect<Document, LandError>;
    // `sm rm --stack` from `located`: what it removes, resolved and
    // checked, for removeStack to carry out.
    readonly planRemoveStack: (
      located: Worktrees.Located,
      options: RemoveOptions,
    ) => Effect.Effect<StackRemoval, RemoveStackError>;
    // `sm rm --stack`: the cleanup half of a stack land, for one that
    // has landed, removing exactly the worktrees its plan names.
    readonly removeStack: (
      removal: StackRemoval,
      reporter: Reporter,
    ) => Effect.Effect<Document, RemoveStackError>;
    // `sm done`: the checkout back on the primary branch, the merged
    // branch it was on deleted.
    readonly done: (
      located: Worktrees.Located,
      options: { readonly force: boolean },
    ) => Effect.Effect<Document, DoneError>;
  }
>()("sm/engine/Landing") {}

const make = Effect.gen(function* () {
  const pullRequests = yield* makePullRequests;
  const stacks = yield* makeStacks({ pullRequests });
  const cleanup = yield* makeCleanup({ pullRequests });
  const verbs = yield* makeVerbs({ pullRequests, stacks, cleanup });
  return Landing.of(verbs);
});

export const layer = Layer.effect(Landing, make);
