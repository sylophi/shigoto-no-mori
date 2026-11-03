// The sign-in with a code (CodeSignInDialog puts it in a ModalShell):
// the page to approve it on, from any device, and the code that page
// shows, while the window waits for the approval.
import { Loader2 } from "lucide-react";
import { DialogFrame } from "../../primitives/dialog.tsx";
import { CopyButton } from "../../primitives/copy-button.tsx";
import { ExternalLink } from "../../primitives/external-link.tsx";

export function CodeSignInDialogView({
  code,
  url,
  onCancel,
}: {
  code: string;
  url: string;
  onCancel: () => void;
}) {
  return (
    <DialogFrame
      title="Sign in with a code"
      onCancel={onCancel}
      note={
        <>
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          Waiting for you to approve it…
        </>
      }
    >
      <div className="mt-4 flex flex-col gap-4">
        <div className="group/copy flex items-center gap-1 text-xs text-muted-foreground">
          <p className="min-w-0">
            Open{" "}
            <ExternalLink href={url} className="break-all">
              {url}
            </ExternalLink>{" "}
            on any device and check it shows this code.
          </p>
          <CopyButton value={url} label="Copy link" />
        </div>
        <p className="text-center font-mono text-2xl font-semibold tracking-widest">
          {code}
        </p>
      </div>
    </DialogFrame>
  );
}
