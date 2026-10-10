import type { CSSProperties } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Title-bar drag region: a non-standard CSS property React's typed
// CSSProperties doesn't model. The camelCase form sets the same style
// through Chromium's CSSOM without React's dev-mode "unsupported style
// property" warning. Wrap the cast in one place so callers just say
// `dragRegion("drag")` or `dragRegion("no-drag")`.
export function dragRegion(value: "drag" | "no-drag"): CSSProperties {
  return { ["WebkitAppRegion" as never]: value };
}

// Exhaustiveness guard. In a `switch` over a discriminated union, putting
// `default: return assertNever(value)` makes adding a new variant a compile
// error until every switch is updated.
export function assertNever(value: never): never {
  throw new Error(`Unreachable: ${JSON.stringify(value)}`);
}
