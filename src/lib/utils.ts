import type { CSSProperties } from "react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// macOS title-bar drag region: a non-standard CSS property React's typed
// CSSProperties doesn't model. Wrap the cast in one place so callers
// just say `dragRegion("drag")` or `dragRegion("no-drag")`.
export function dragRegion(value: "drag" | "no-drag"): CSSProperties {
  return { ["-webkit-app-region" as never]: value };
}
