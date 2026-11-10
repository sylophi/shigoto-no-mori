// The reword dialog's content (useCommitActions' RewordDialog puts it
// in a ModalShell): the commit's summary and description, editable,
// read off the commit before the form shows.
import type { Binding } from "../../../lib/keymap.ts";
import type { KeyboardEvent } from "react";
import { Button } from "../../../primitives/button.tsx";
import { DialogFrame } from "../../../primitives/dialog.tsx";
import { Input } from "../../../primitives/input.tsx";
import { Textarea } from "../../../primitives/textarea.tsx";

function title(hash: string) {
  return (
    <>
      Reword <span className="font-mono">{hash}</span>
    </>
  );
}

// While the commit's message is read, holding the form's place.
export function RewordLoadingView({
  hash,
  onCancel,
}: {
  hash: string;
  onCancel: () => void;
}) {
  return (
    <DialogFrame title={title(hash)} onCancel={onCancel}>
      <div className="mt-4 h-40" />
    </DialogFrame>
  );
}

export function RewordDialogView({
  hash,
  summary,
  onSummaryChange,
  description,
  onDescriptionChange,
  canSave,
  onSave,
  onCancel,
  saveKeys,
}: {
  hash: string;
  summary: string;
  onSummaryChange: (summary: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  canSave: boolean;
  onSave: () => void;
  onCancel: () => void;
  // The keymap's save (⌘↩ unless rebound).
  saveKeys: Binding;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (saveKeys.matches(e)) {
      e.preventDefault();
      onSave();
    }
  };
  return (
    <DialogFrame
      title={title(hash)}
      onCancel={onCancel}
      actions={
        <Button
          size="sm"
          onClick={onSave}
          disabled={!canSave}
          keys={saveKeys.label}
          aria-keyshortcuts={saveKeys.aria}
        >
          Reword
        </Button>
      }
    >
      <div className="mt-4 flex flex-col gap-2">
        <Input
          className="px-3 py-2 text-sm"
          aria-label="Summary"
          placeholder="Summary (required)"
          value={summary}
          onChange={(e) => onSummaryChange(e.target.value)}
          onKeyDown={onKeyDown}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to edit this field
          autoFocus
        />
        <Textarea
          className="px-3 py-2 text-sm"
          aria-label="Description"
          placeholder="Description"
          rows={5}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </DialogFrame>
  );
}
