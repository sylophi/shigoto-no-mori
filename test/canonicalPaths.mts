// node:path and realpath for the tests, answering canonical paths
// (packages/engine/src/canonicalPath.ts), so a path a test builds is
// spelled as the engine spells the same folder. The real path is the
// OS's own, as git resolves it.
import { realpathSync } from "node:fs";
import * as NodePath from "node:path";
import { canonicalPath } from "../packages/engine/src/canonicalPath.ts";

export { basename, delimiter } from "node:path";

export const join = (...paths: ReadonlyArray<string>) =>
  canonicalPath(NodePath.join(...paths));

export const dirname = (path: string) => canonicalPath(NodePath.dirname(path));

export const resolve = (...paths: ReadonlyArray<string>) =>
  canonicalPath(NodePath.resolve(...paths));

export const realpath = (path: string) =>
  canonicalPath(realpathSync.native(path));
