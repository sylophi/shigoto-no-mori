// Every walk file's: what each case came to, for its lab's close.
import { afterEach } from "vitest";
import { noteCase } from "./failed.mts";

afterEach(({ task }) => noteCase(task.result?.state));
