import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Single source of truth for text-field chrome. Sizing, font, and layout
// stay at the call site; this carries the surface + focus treatment so
// every field reads the same and theme overlays (doubutsu) have one
// stable data-slot hook instead of a per-site class contract.
export const fieldClass =
  "rounded-md border border-input bg-background transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input data-slot="input" className={cn(fieldClass, className)} {...props} />
  );
}
