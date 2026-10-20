// What a case owns (testProcesses.mts) ends when the case does,
// passed, failed or out of time, and everything the file's process
// started ends with the file, and with the run however it ends.
// onTestFinished runs even when an afterEach before it threw, which
// stops the rest of the afterEach hooks.
import { afterAll, beforeEach, onTestFinished } from "vitest";
import { caseScope, endAll, endsWithRun } from "./testProcesses.mts";

beforeEach(() => {
  onTestFinished(caseScope());
});
afterAll(endAll);
endsWithRun();
// vitest's own process gone without stopping this fork (a SIGTERM to it
// alone exits it at once): the fork's exit ends what it started.
process.once("disconnect", () => process.exit(1));
