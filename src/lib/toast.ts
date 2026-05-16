import { toast } from "sonner";

function describe(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return undefined;
}

// Same title + same error text collapses into one toast — useful when a
// fan-out of queries all fail with the same root cause.
export function notifyError(message: string, err?: unknown): void {
  const description = describe(err);
  toast.error(message, {
    id: `error:${message}:${description ?? ""}`,
    description,
  });
}

export { toast };
