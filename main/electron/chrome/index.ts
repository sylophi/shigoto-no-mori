// Platform selection for native window chrome. main/index.ts talks only
// to `platformChrome`; the per-OS choices live in darwin.ts / win32.ts.
import { isWindows } from "../../lib/util/platform";
import { darwinChrome } from "./darwin";
import type { PlatformChrome } from "./types";
import { win32Chrome } from "./win32";

export type { PlatformChrome } from "./types";

export const platformChrome: PlatformChrome = isWindows
  ? win32Chrome
  : darwinChrome;
