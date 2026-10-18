// Set by setup.mts, read by labApp.mts's close. A walk none of whose
// cases ran failed in a hook (its beforeAll), which skipped them all.
let ran = 0;
let failed = false;

export const noteCase = (state: string | undefined): void => {
  ran += 1;
  if (state === "fail") failed = true;
};
export const walkFailed = (): boolean => failed || ran === 0;
