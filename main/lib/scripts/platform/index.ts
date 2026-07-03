// Platform selection for script spawning and tree killing. The scripts
// layer talks only to `scriptPlatform`; the per-OS mechanics live in
// darwin.ts / win32.ts.
import { isWindows } from "../../util/platform";
import { darwinScriptPlatform } from "./darwin";
import type { ScriptPlatform } from "./types";
import { win32ScriptPlatform } from "./win32";

export type { ScriptPlatform, SpawnScriptOptions } from "./types";

export const scriptPlatform: ScriptPlatform = isWindows
  ? win32ScriptPlatform
  : darwinScriptPlatform;
