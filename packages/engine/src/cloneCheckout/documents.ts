// CloneCheckout's documents, errors and the pure helpers its areas
// share. `CloneCheckout.ts` re-exports what consumers use.
import * as Schema from "effect/Schema";
import type { CheckoutConfig } from "../gitIndex.ts";

// How a clone checkout went: tracked files cloned, paths git wrote
// (submodules included), and clones read back and hashed.
export type CloneReport = {
  readonly cloned: number;
  readonly written: number;
  readonly hashed: number;
};

// Why a clone checkout gave up, the worktree then checked out by git.
export class CloneFailed extends Schema.TaggedError<CloneFailed>()(
  "CloneFailed",
  {
    reason: Schema.Literals([
      "index-changed",
      "attributes-changed",
      "unknown-format",
      "read",
      "clone",
      "write",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "index-changed":
        return "source index changed while it was read";
      case "attributes-changed":
        return "attributes changed while cloning";
      case "unknown-format":
        return "unknown object format";
      case "read":
        return "couldn't read the source";
      case "clone":
        return "couldn't clone the files";
      case "write":
        return "couldn't write the index";
    }
  }
}

// A worktree added --no-checkout that neither the clone nor git's own
// checkout filled. The caller undoes the add, as git does when its own
// checkout fails.
export class CheckoutUnfinished extends Schema.TaggedError<CheckoutUnfinished>()(
  "CheckoutUnfinished",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't check out ${this.path}.`;
  }
}

// A post-checkout hook that failed, as `git worktree add` reports one:
// the worktree stays. What the hook printed is the cause.
export class HookFailed extends Schema.TaggedError<HookFailed>()("HookFailed", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The post-checkout hook failed.";
  }
}

// A clone the source no longer has, or isn't ours to read: git writes it
// instead.
export const LEFT_TO_GIT = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"]);

// What decided the conversions, read once and read again.
type Conversions = {
  readonly attr: string;
  readonly sourceAttr: string;
  readonly config: CheckoutConfig;
  readonly sourceConfig: CheckoutConfig;
};

export const sameConversions = (a: Conversions, b: Conversions) =>
  a.attr === b.attr &&
  a.sourceAttr === b.sourceAttr &&
  JSON.stringify(a.config) === JSON.stringify(b.config) &&
  JSON.stringify(a.sourceConfig) === JSON.stringify(b.sourceConfig);

export const RECORDS_PER_STATEMENT = 1000;
