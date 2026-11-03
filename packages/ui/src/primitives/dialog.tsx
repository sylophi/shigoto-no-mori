// What a dialog draws inside its ModalShell. A short confirm or form is
// a DialogFrame. A bigger dialog stacks the banded DialogHeader,
// DialogBody and DialogFooter, and the multi-step flows put their step
// rail between the header and the body (views/worktreeDetail/flow).
import { X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";
import { Button } from "./button.tsx";

export function DialogFrame({
  title,
  children,
  note,
  actions,
  destructive = false,
  busy = false,
  onCancel,
  onSubmit,
}: {
  title: ReactNode;
  children: ReactNode;
  // A line at the start of the footer, across from the buttons.
  note?: ReactNode;
  // The buttons after Cancel.
  actions?: ReactNode;
  // Opens on Cancel, so a stray Enter backs out.
  destructive?: boolean;
  // Holds Cancel while the action runs.
  busy?: boolean;
  onCancel: () => void;
  // Makes the frame a form, which Enter submits.
  onSubmit?: () => void;
}) {
  const content = (
    <>
      <h2 className="text-base font-semibold break-words">{title}</h2>
      {children}
      <div className="mt-5 flex items-center justify-end gap-2">
        {note && (
          <div className="mr-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {note}
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- a destructive dialog opens on Cancel
          autoFocus={destructive}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        {actions}
      </div>
    </>
  );
  const className = "flex min-h-0 flex-col p-5";
  if (!onSubmit) return <div className={className}>{content}</div>;
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {content}
    </form>
  );
}

// A tinted icon square, the title, one line under it, any actions of
// the dialog's own, and either the close button or (once a flow's
// attempt runs) its clock in the same corner.
export function DialogHeader({
  tint,
  icon: Icon,
  spin = false,
  title,
  children,
  elapsed,
  actions,
  onClose,
}: {
  tint: string;
  icon: LucideIcon;
  spin?: boolean;
  title: ReactNode;
  children: ReactNode;
  elapsed?: { ms: number; label: "elapsed" | "total" };
  actions?: ReactNode;
  onClose: () => void;
}) {
  return (
    <header className="flex items-start gap-3 px-5 py-4">
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          tint,
        )}
      >
        <Icon className={cn("size-4", spin && "animate-spin")} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="text-xs text-muted-foreground">{children}</div>
      </div>
      {actions}
      {elapsed === undefined ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close"
          onClick={onClose}
        >
          <X />
        </Button>
      ) : (
        <div className="shrink-0 text-right leading-tight">
          <p className="font-mono text-lg font-semibold tabular-nums">
            {formatElapsed(elapsed.ms)}
          </p>
          <p className="text-3xs tracking-wide text-muted-foreground uppercase">
            {elapsed.label}
          </p>
        </div>
      )}
    </header>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function DialogBody({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
  );
}

// A footer without a note is the buttons alone.
export function DialogFooter({
  note,
  children,
}: {
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-3 border-t border-border bg-muted/30 px-5 py-3">
      {note && (
        <p className="min-w-0 flex-1 basis-56 text-xs text-muted-foreground">
          {note}
        </p>
      )}
      {children && (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {children}
        </div>
      )}
    </footer>
  );
}
