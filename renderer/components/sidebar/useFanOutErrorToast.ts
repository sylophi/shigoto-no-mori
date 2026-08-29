// The per-project listing queries are silent so the fan-out doesn't
// spam toasts. Both shells coalesce the same observations into this one
// toast (and dismiss it when the failures clear), so a remote listing
// error can never vanish from the web tree without a trace.
import { useEffect } from "react";
import { toast } from "@/lib/toast";

export function useFanOutErrorToast(failedCount: number): void {
  useEffect(() => {
    const id = "worktrees-fanout-error";
    if (failedCount === 0) {
      toast.dismiss(id);
      return;
    }
    toast.error(
      `Couldn't load worktrees for ${failedCount} ${failedCount === 1 ? "project" : "projects"}`,
      { id },
    );
  }, [failedCount]);
}
