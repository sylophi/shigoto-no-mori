// The errors Open's areas share (EFFECT.md, section 2). `Open.ts`
// re-exports what consumers use.
import * as Schema from "effect/Schema";

// The launcher wouldn't open, in the words of what refused.
export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()(
  "LaunchFailed",
  { label: Schema.String, said: Schema.String },
) {
  override get message(): string {
    return `Couldn't open ${this.label}: ${this.said}`;
  }
}
