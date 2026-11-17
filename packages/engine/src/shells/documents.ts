// What the shells of each OS (../Shells.ts) share.
import * as Schema from "effect/Schema";

// No shell for a project's command lines, nor the engine's sh: on
// Windows both are Git Bash's, which comes with Git for Windows and is
// found beside the git on PATH. `gitRoot` is the install it was looked
// for in, none when no git answered.
export class NoScriptShell extends Schema.TaggedError<NoScriptShell>()(
  "NoScriptShell",
  {
    gitRoot: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.gitRoot === undefined
      ? "No git on PATH, so no Git Bash for scripts to run in. Install Git for Windows."
      : `git found, no bash beside it in ${this.gitRoot}. Scripts run in the Git Bash that comes with Git for Windows.`;
  }
}
