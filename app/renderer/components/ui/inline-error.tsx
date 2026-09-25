// An error message shown where there is no room for it: a footer bar,
// a row, a toast. The text keeps to its line budget, and once it no
// longer fits, a Details button opens the whole message in a dialog
// instead of the text spilling into the layout or being cut for good.
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { ModalShell } from "@/components/ui/modal-shell";
import { useIsTruncated } from "@/hooks/ui/useIsTruncated";
import { cn } from "@/lib/utils";
import { createExternalStore, useExternalStore } from "@/store/externalStore";

interface ErrorDetails {
  title: string;
  message: string;
}

// One dialog for the whole app, mounted at the root: the text a toast
// hands over has to outlive the toast, which can time out while the
// dialog is still being read.
const details = createExternalStore<ErrorDetails | null>(null);

// One line keeps Details beside the text, as a footer row would.
// Multiline stacks it underneath, so it doesn't narrow every line above
// it.
const LAYOUT = {
  line: { row: "items-baseline gap-2", text: "truncate" },
  multiline: {
    row: "flex-col items-start gap-1",
    text: "line-clamp-3 whitespace-pre-wrap wrap-anywhere",
  },
} as const;

interface InlineErrorProps {
  message: string;
  // The dialog's heading: what failed, since the message alone is often
  // a bare git line.
  title: string;
  // Up to three lines, breaks kept, where a toast has the height for it.
  multiline?: boolean;
  className?: string;
}

export function InlineError({
  message,
  title,
  multiline = false,
  className,
}: InlineErrorProps) {
  const [textRef, overflowing] = useIsTruncated<HTMLSpanElement>(message);
  const layout = LAYOUT[multiline ? "multiline" : "line"];
  // One line collapses the breaks, so what follows the first one reads
  // as if it belonged to it.
  const clipped = overflowing || (!multiline && message.trim().includes("\n"));

  return (
    <span className={cn("flex min-w-0", layout.row, className)}>
      <span
        ref={textRef}
        className={cn("max-w-full min-w-0 select-text", layout.text)}
      >
        {message}
      </span>
      {clipped && (
        <button
          type="button"
          onClick={() => details.publish({ title, message })}
          className="shrink-0 font-medium underline underline-offset-2 hover:text-foreground"
        >
          Details
        </button>
      )}
    </span>
  );
}

export function ErrorDetailsHost() {
  const current = useExternalStore(details);
  if (!current) return null;
  const close = () => details.publish(null);
  return (
    <ModalShell onClose={close} popoverClassName="max-w-2xl">
      <div className="flex flex-col gap-3 p-5">
        <div className="group/copy flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-base font-semibold">
            {current.title}
          </h2>
          <CopyButton value={current.message} label="Copy error" />
        </div>
        <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs wrap-anywhere whitespace-pre-wrap select-text">
          {current.message}
        </pre>
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            // oxlint-disable-next-line jsx-a11y/no-autofocus -- a dialog opened by a click should take focus
            autoFocus
            onClick={close}
          >
            Close
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
