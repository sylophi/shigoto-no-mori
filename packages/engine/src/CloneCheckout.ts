// Clone checkout: a new worktree's tracked files cloned out of an
// existing checkout (APFS clonefile) instead of written by git. A clone
// shares the source's blocks, so a whole directory lands in one call
// however many files it holds, and the new worktree's index is written
// here with each clone's own stat, so git trusts the files without
// reading them back. Letting git build that index would hash every
// clone, slower than the plain checkout this replaces.
//
// A file is only cloned when the source's index vouches for its bytes:
// the same blob and mode as the new worktree's commit, an ordinary entry
// (no conflict, skip-worktree, assume-unchanged, intent-to-add), not
// racily clean, no attribute or config on either side that would make a
// checkout write anything but the blob, and, checked once it is cloned,
// a file on disk whose stat still matches what git recorded when it last
// hashed it (to the nanosecond, so an edit before or during the clone
// shows), with nothing on it a checkout wouldn't give it (other
// permissions, file flags, extended attributes). Everything else is left
// to `git checkout-index`, which writes it as a checkout would.
//
// Any failure resets the worktree to a plain checkout, so the worst a
// clone checkout does is cost the time it took.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type { Source } from "./CarryOver.ts";
import { makeCloning } from "./cloneCheckout/cloning.ts";
import {
  CheckoutUnfinished,
  type CloneFailed,
  type CloneReport,
  type HookFailed,
} from "./cloneCheckout/documents.ts";
import { makeHook } from "./cloneCheckout/hook.ts";
import { makeReads } from "./cloneCheckout/reads.ts";
import { makeSources } from "./cloneCheckout/sources.ts";
import { makeVerified } from "./cloneCheckout/verified.ts";
import * as Git from "./Git.ts";
export {
  CheckoutUnfinished,
  CloneFailed,
  HookFailed,
} from "./cloneCheckout/documents.ts";
export type { CloneReport } from "./cloneCheckout/documents.ts";

export class CloneCheckout extends Context.Service<
  CloneCheckout,
  {
    // The checkout a new worktree at `destination` would clone from: the
    // one on `baseBranch`, else the primary, else any other. None when
    // the project or every checkout rules a clone out.
    readonly pickSource: (input: {
      readonly repo: string;
      readonly checkouts: ReadonlyArray<Source>;
      readonly destination: string;
      readonly baseBranch: string;
    }) => Effect.Effect<Option.Option<Source>>;
    // Fills a worktree made --no-checkout: its files cloned from `source`
    // where that is safe and written by git elsewhere, else all written by
    // git when the clone gives up, then the post-checkout hook git
    // skipped. Answers how the clone went, or why it gave up.
    readonly finish: (input: {
      readonly source: string;
      readonly worktree: string;
    }) => Effect.Effect<
      Result.Result<CloneReport, CloneFailed>,
      CheckoutUnfinished | HookFailed | Git.GitError
    >;
    // The clone checkout itself, for a worktree made --no-checkout. On
    // failure the caller resets the worktree.
    readonly clone: (
      source: string,
      worktree: string,
    ) => Effect.Effect<CloneReport, CloneFailed>;
    // Empties the worktree (but its .git link) and checks HEAD out with
    // git, the state a plain `git worktree add` leaves.
    readonly resetToPlainCheckout: (
      worktree: string,
    ) => Effect.Effect<void, Git.GitError>;
    // Drops what clones proved about a source's files.
    readonly forget: (worktreeId: string) => Effect.Effect<void>;
  }
>()("sm/engine/CloneCheckout") {}

const make = Effect.gen(function* () {
  const git = yield* Git.Git;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const reads = yield* makeReads;
  const verified = yield* makeVerified;
  const { forceRemove, clone } = yield* makeCloning({ reads, verified });
  const { runPostCheckoutHook } = yield* makeHook;
  const { pickSource } = yield* makeSources({ reads });

  const resetToPlainCheckout = Effect.fn("CloneCheckout.resetToPlainCheckout")(
    function* (worktree: string) {
      const entries = yield* fs
        .readDirectory(worktree)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const name of entries) {
        if (name !== ".git") {
          yield* forceRemove(path.join(worktree, name)).pipe(Effect.ignore);
        }
      }
      yield* git.run(worktree, ["read-tree", "--reset", "-u", "HEAD"]);
    },
  );

  const finish = Effect.fn("CloneCheckout.finish")(function* (input: {
    readonly source: string;
    readonly worktree: string;
  }) {
    const outcome = yield* clone(input.source, input.worktree).pipe(
      Effect.result,
    );
    if (Result.isFailure(outcome)) {
      yield* resetToPlainCheckout(input.worktree).pipe(
        Effect.mapError(
          (cause) => new CheckoutUnfinished({ path: input.worktree, cause }),
        ),
      );
    }
    const head = (yield* git.run(input.worktree, ["rev-parse", "HEAD"])).trim();
    yield* runPostCheckoutHook(input.worktree, head);
    return outcome;
  });

  return CloneCheckout.of({
    pickSource,
    finish,
    clone,
    resetToPlainCheckout,
    forget: verified.forget,
  });
});

export const layer = Layer.effect(CloneCheckout, make);
