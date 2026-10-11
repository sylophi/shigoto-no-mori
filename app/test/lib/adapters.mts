// Every proof's file runs with the host's services up (hostRuntime.mts).
import { afterAll, beforeAll } from "vitest";
import { disposeHost, startHost } from "./hostRuntime.mts";

beforeAll(startHost);
afterAll(disposeHost);
