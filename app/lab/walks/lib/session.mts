// Whether this Mac's session is locked. A locked session shows the app's
// native dialogs to no one, System Events included, so a walk of them
// can't run there and skips, saying why, rather than failing.
import { execFileSync } from "node:child_process";
import { beforeEach } from "vitest";

export const locked = (() => {
  try {
    return (
      execFileSync(
        "osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          `ObjC.import("CoreGraphics");
const session = ObjC.castRefToObject($.CGSessionCopyCurrentDictionary());
String(ObjC.unwrap(session.objectForKey("CGSSessionScreenIsLocked")))`,
        ],
        { encoding: "utf8" },
      ).trim() === "true"
    );
  } catch {
    return false;
  }
})();

// Every case of the calling walk file skipped while the session is locked.
export const skipWhenLocked = (): void => {
  const why =
    "the screen is locked, and the app's native dialogs show only in an unlocked session (CI's Walks has one)";
  let said = false;
  beforeEach(({ skip, task }) => {
    if (!locked) return;
    if (!said)
      process.stderr.write(`[walks] ${task.file.name} skipped: ${why}\n`);
    said = true;
    skip(why);
  });
};
