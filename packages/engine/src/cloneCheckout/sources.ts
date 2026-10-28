// Which checkout a new worktree clones from, if any.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { orderSources, type Source } from "../CarryOver.ts";
import * as NativeFs from "../NativeFs.ts";
import { envVar } from "../environment.ts";
import * as Git from "../Git.ts";
import type { ReadsArea } from "./reads.ts";

export const makeSources = ({
  reads: { configValue, configBool },
}: {
  readonly reads: ReadsArea;
}) =>
  Effect.gen(function* () {
    const git = yield* Git.Git;
    const nativeFs = yield* NativeFs.NativeFs;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Whether the project's checkouts can't be cloned from: a sparse
    // checkout's new worktree is sparse too, which only git lays out, and a
    // split index keeps entries whose raciness cutoff isn't the index's own.
    const sparseOrSplit = Effect.fnUntraced(function* (checkout: string) {
      return (
        (yield* configBool(checkout, "core.sparseCheckout")) ||
        (yield* configBool(checkout, "core.splitIndex"))
      );
    });

    const projectBlocked = Effect.fnUntraced(function* (repo: string) {
      if (yield* sparseOrSplit(repo)) return true;
      // Replacement objects change what a blob reads as, so the source's
      // files needn't hold what a checkout writes now.
      if ((yield* envVar("GIT_NO_REPLACE_OBJECTS")) !== "") return false;
      const useReplace = yield* configValue(repo, [
        "--bool",
        "core.useReplaceRefs",
      ]);
      const base = yield* envVar("GIT_REPLACE_REF_BASE");
      const refs = yield* git
        .run(repo, [
          "for-each-ref",
          "--count=1",
          "--format=x",
          base === "" ? "refs/replace/" : base,
        ])
        .pipe(Effect.orElseSucceed(() => ""));
      return !Option.contains(useReplace, "false") && refs.trim() !== "";
    });

    // Whether a checkout can be cloned from into `destination`: on the
    // same volume, one that can clone, neither sparse nor split.
    const sourceUsable = Effect.fnUntraced(function* (
      source: string,
      destination: string,
    ) {
      const [from, parent] = yield* Effect.all([
        fs.stat(source).pipe(Effect.option),
        fs.stat(path.dirname(destination)).pipe(Effect.option),
      ]);
      if (Option.isNone(from) || Option.isNone(parent)) return false;
      if (from.value.dev !== parent.value.dev) return false;
      const answers = yield* nativeFs.cloneable({ root: source }).pipe(
        Stream.runCollect,
        Effect.orElseSucceed(() => []),
      );
      const answer = answers[0];
      if (
        answer === undefined ||
        NativeFs.isFailed(answer) ||
        !answer.cloneable
      ) {
        return false;
      }
      return !(yield* sparseOrSplit(source));
    });

    const pickSource = Effect.fn("CloneCheckout.pickSource")(function* (input: {
      readonly repo: string;
      readonly checkouts: ReadonlyArray<Source>;
      readonly destination: string;
      readonly baseBranch: string;
    }) {
      if (yield* projectBlocked(input.repo)) return Option.none<Source>();
      // In carry-over's order: the checkout on the base branch, the
      // primary, then the rest by name.
      const ordered = orderSources(
        input.checkouts,
        input.destination,
        input.baseBranch,
      );
      for (const source of ordered) {
        if (yield* sourceUsable(source.path, input.destination)) {
          return Option.some(source);
        }
      }
      return Option.none<Source>();
    });

    return { pickSource };
  });
