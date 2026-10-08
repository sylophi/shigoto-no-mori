// Git bundles, how a transfer carries commits between devices: one made
// of a repository's refs (less the commits the far side already has),
// and one unpacked into refs under refs/shigomori/.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Git from "./Git.ts";

export type RefTip = { readonly ref: string; readonly commit: string };

export type BundleMade = {
  readonly path: string;
  readonly bytes: number;
  readonly refs: ReadonlyArray<RefTip>;
  // The haves this repository doesn't know, which the bundle can't
  // leave out.
  readonly skippedHaves: ReadonlyArray<string> | null;
};

// A ref, a have, a refspec or a bundle that won't do. `subject` is what
// was given, and `said` git's words where git refused.
export class BundleRefused extends Schema.TaggedError<BundleRefused>()(
  "BundleRefused",
  {
    reason: Schema.Literals([
      "bad-ref",
      "unknown-ref",
      "bad-have",
      "bad-refspec",
      "not-a-bundle",
      "unfetchable",
    ]),
    subject: Schema.String,
    said: Schema.optional(Schema.String),
  },
) {
  get documentCode(): string {
    return this.reason === "not-a-bundle" || this.reason === "unfetchable"
      ? "bad-bundle"
      : this.reason;
  }

  override get message(): string {
    const quoted = JSON.stringify(this.subject);
    switch (this.reason) {
      case "bad-ref":
        return `Invalid ref ${quoted}.`;
      case "unknown-ref":
        return `Ref ${quoted} does not exist here.`;
      case "bad-have":
        return `Invalid have ${quoted} (must be a hex commit hash).`;
      case "bad-refspec":
        return `Invalid refspec ${quoted}: need <src>:<dst> full refs with dst under ${SHIGOMORI_REFS}.`;
      case "not-a-bundle":
        return `Not a valid git bundle: ${this.said ?? ""}`;
      case "unfetchable":
        return `Couldn't fetch from the bundle: ${this.said ?? ""}`;
    }
  }
}

const SHIGOMORI_REFS = "refs/shigomori/";

const REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const COMMIT = /^[0-9a-f]{4,64}$/;

// A full ref git takes without question: no `..`, `//`, trailing slash
// or .lock.
export const validRef = (ref: string) =>
  REF.test(ref) &&
  !ref.includes("..") &&
  !ref.includes("//") &&
  !ref.endsWith("/") &&
  !ref.endsWith(".lock");

export class Bundle extends Context.Service<
  Bundle,
  {
    // `refs` bundled at `out` (git's path, from the repository), less
    // what the `haves` reach.
    readonly create: (
      repo: string,
      out: string,
      refs: ReadonlyArray<string>,
      haves: ReadonlyArray<string>,
    ) => Effect.Effect<BundleMade, BundleRefused | Git.GitError>;
    // Each `<src>:<dst>` refspec fetched from the bundle at `bundle`,
    // forced, into a ref under refs/shigomori/.
    readonly unpack: (
      repo: string,
      bundle: string,
      refspecs: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<RefTip>, BundleRefused | Git.GitError>;
  }
>()("sm/engine/Bundle") {}

// Git's words for a failed run, as Go said them: the command, then
// its stderr.
const said = (args: ReadonlyArray<string>) => (error: Git.GitError) =>
  `git ${args.join(" ")}: ${error instanceof Git.GitCommandError ? Git.stderrOf(error) : error.message}`;

const make = Effect.gen(function* () {
  const git = yield* Git.Git;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tips = (repo: string, refs: ReadonlyArray<string>) =>
    Effect.forEach(refs, (ref) =>
      Effect.map(git.verifyRev(repo, ref), (commit) => ({ ref, commit })),
    );

  const create = Effect.fn("Bundle.create")(function* (
    repo: string,
    out: string,
    refs: ReadonlyArray<string>,
    haves: ReadonlyArray<string>,
  ) {
    for (const ref of refs) {
      if (!validRef(ref)) {
        return yield* new BundleRefused({ reason: "bad-ref", subject: ref });
      }
      const exists = yield* git
        .run(repo, ["show-ref", "--verify", "--quiet", ref])
        .pipe(Effect.isSuccess);
      if (!exists) {
        return yield* new BundleRefused({
          reason: "unknown-ref",
          subject: ref,
        });
      }
    }
    for (const have of haves) {
      if (!COMMIT.test(have)) {
        return yield* new BundleRefused({ reason: "bad-have", subject: have });
      }
    }
    // The haves this repository has as commits leave their history out.
    const answers =
      haves.length === 0
        ? []
        : (yield* git.run(repo, ["cat-file", "--batch-check"], {
            stdin: haves.map((have) => `${have}^{commit}\n`).join(""),
          }))
            .replace(/\n$/, "")
            .split("\n");
    const known = haves.filter(
      (_, index) => answers[index]?.trim().split(/\s+/)[1] === "commit",
    );
    const skipped = haves.filter((have) => !known.includes(have));
    yield* git.run(repo, [
      "bundle",
      "create",
      out,
      "--end-of-options",
      ...known.map((have) => `^${have}`),
      ...refs,
    ]);
    const { size } = yield* fs.stat(path.resolve(repo, out)).pipe(Effect.orDie);
    return {
      path: out,
      bytes: Number(size),
      refs: yield* tips(repo, refs),
      skippedHaves: skipped.length === 0 ? null : skipped,
    };
  });

  const unpack = Effect.fn("Bundle.unpack")(function* (
    repo: string,
    bundle: string,
    refspecs: ReadonlyArray<string>,
  ) {
    const specs: string[] = [];
    const targets: string[] = [];
    for (const spec of refspecs) {
      const at = spec.indexOf(":");
      const [src, dst] =
        at < 0 ? ["", ""] : [spec.slice(0, at), spec.slice(at + 1)];
      if (
        at < 0 ||
        !validRef(src) ||
        !validRef(dst) ||
        !dst.startsWith(SHIGOMORI_REFS)
      ) {
        return yield* new BundleRefused({
          reason: "bad-refspec",
          subject: spec,
        });
      }
      specs.push(`+${src}:${dst}`);
      targets.push(dst);
    }
    const verify = ["bundle", "verify", "--end-of-options", bundle];
    yield* git.run(repo, verify).pipe(
      Effect.mapError(
        (error) =>
          new BundleRefused({
            reason: "not-a-bundle",
            subject: bundle,
            said: said(verify)(error),
          }),
      ),
    );
    const fetch = [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--quiet",
      "--end-of-options",
      bundle,
      ...specs,
    ];
    yield* git.run(repo, fetch).pipe(
      Effect.mapError(
        (error) =>
          new BundleRefused({
            reason: "unfetchable",
            subject: bundle,
            said: said(fetch)(error),
          }),
      ),
    );
    return yield* tips(repo, targets);
  });

  return Bundle.of({ create, unpack });
});

export const layer = Layer.effect(Bundle, make);
