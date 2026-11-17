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

// The app wouldn't open: not installed, or `open` refused.
export class AppNotOpened extends Schema.TaggedError<AppNotOpened>()(
  "AppNotOpened",
  { appName: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Couldn't open ${this.appName}. Is the app installed?`;
  }
}

// On Linux the app is its host alone, with no window to open.
export class NoAppWindow extends Schema.TaggedError<NoAppWindow>()(
  "NoAppWindow",
  {},
) {
  override get message(): string {
    return "On Linux the app is its host, with no window to open: open this machine from the app on another device.";
  }
}

// Where the installed app is on Windows comes with its installer.
export class NoWindowsApp extends Schema.TaggedError<NoWindowsApp>()(
  "NoWindowsApp",
  {},
) {
  override get message(): string {
    return "sm doesn't open the app on Windows. Open it from the Start menu.";
  }
}
