import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

// A line of caution under what a dialog is about to do.
export function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
      <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </p>
  );
}
