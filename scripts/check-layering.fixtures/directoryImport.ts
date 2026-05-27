// Fixture: a directory import that resolves to a bare `main/ipc` path
// (no trailing slash). Without `isPathOrChild`, the `startsWith("main/ipc/")`
// check would miss this and the violation would slip through.
import { foo } from "../../main/ipc";

export const x = foo;
