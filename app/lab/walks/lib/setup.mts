// Every walk file's: a case that failed is noted for its lab's close.
import { afterEach } from "vitest";
import { noteWalkFailed } from "./failed.mts";

afterEach(({ task }) => {
  if (task.result?.state === "fail") noteWalkFailed();
});
