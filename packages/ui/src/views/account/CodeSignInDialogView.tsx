// The sign-in with a code (CodeSignInDialog puts it in a ModalShell):
// the page to approve it on, from any device, and the code that page
// shows, while the window waits for the approval.
import { Loader2 } from "lucide-react";
import { Button } from "../../primitives/button.tsx";
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
    <div className="flex flex-col gap-4 p-5">
      <h2 className="text-base font-semibold">Sign in with a code</h2>
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
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          Waiting for you to approve it…
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
