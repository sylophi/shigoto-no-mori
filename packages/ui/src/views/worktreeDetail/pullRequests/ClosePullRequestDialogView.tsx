// The close pull request dialog's content (ClosePullRequestDialog puts
// it in a ModalShell).
import { GitPullRequestClosed, Loader2 } from "lucide-react";
import { Button } from "../../../primitives/button.tsx";
import { ErrorBanner } from "../../../primitives/error-banner.tsx";
import { TONE_PILL } from "../../../primitives/status-dot.tsx";
import { DescriptionEditorView } from "../../newPullRequest/DescriptionEditorView.tsx";
import {
  FlowBodyView,
  FlowFooterView,
  FlowHeaderView,
} from "../flow/FlowChromeView.tsx";

// A PR closed unmerged, with a closing comment if one is written.
export function ClosePullRequestDialogView({
  pr,
  comment,
  error,
  busy,
  onComment,
  onConfirm,
  onCancel,
  onClose,
}: {
  pr: { number: number; title: string };
  comment: string;
  error: string | undefined;
  busy: boolean;
  onComment: (comment: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  // The header's close, which waits while the close runs.
  onClose: () => void;
}) {
  return (
    <>
      <FlowHeaderView
        tint={TONE_PILL.rose}
        icon={GitPullRequestClosed}
        title="Close pull request"
        onClose={onClose}
      >
        <p className="truncate">
          #{pr.number} {pr.title}
        </p>
      </FlowHeaderView>

      <FlowBodyView>
        <div className="flex flex-col gap-5">
          <DescriptionEditorView
            label="Comment"
            value={comment}
            onChange={onComment}
            disabled={busy}
          />
          {error !== undefined && (
            <ErrorBanner
              title="Couldn't close the pull request"
              message={error}
            />
          )}
        </div>
      </FlowBodyView>

      <FlowFooterView>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          {busy
            ? "Closing…"
            : comment.trim() === ""
              ? "Close pull request"
              : "Close with comment"}
        </Button>
      </FlowFooterView>
    </>
  );
}
