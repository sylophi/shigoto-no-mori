import { expect } from "vitest";

// Set by setup.mts, read by labApp.mts's close. A walk none of whose
// cases began failed in a hook (its beforeAll), which skipped them all.
// A device closed inside a file's first case closes before its
// afterEach counts it, so a case under way is not that.
let ran = 0;
let failed = false;

export const noteCase = (state: string | undefined): void => {
  ran += 1;
  if (state === "fail") failed = true;
};
export const walkFailed = (): boolean =>
  failed || (ran === 0 && !expect.getState().currentTestName);
