import { toast } from "sonner";
import { InlineError } from "@/components/ui/inline-error";

function describe(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return undefined;
}

// Same title + same error text collapses into one toast. Useful when a
// fan-out of queries all fail with the same root cause.
export function notifyError(message: string, err?: unknown): void {
  const description = describe(err);
  toast.error(message, {
    id: `error:${message}:${description ?? ""}`,
    // Clamped: a git or hook failure can be pages of stderr, which the
    // Details dialog holds instead of the toast.
    description: description && (
      <InlineError message={description} title={message} multiline />
    ),
  });
}

// How long a toast that carries an undo (or redo) waits before it goes:
// long enough to read what just changed and change your mind.
export const UNDO_TOAST_MS = 12_000;

export { toast };
