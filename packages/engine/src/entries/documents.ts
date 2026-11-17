// What the copies of each OS (../entries.ts) share.
import * as Schema from "effect/Schema";

// A copy that didn't finish. cp's own words are the cause.
export class CopyFailed extends Schema.TaggedError<CopyFailed>()("CopyFailed", {
  to: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Couldn't copy to ${this.to}.`;
  }
}
