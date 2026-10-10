// The reword dialog's content (useCommitActions' RewordDialog puts it
// in a ModalShell): the commit's summary and description, editable,
// read off the commit before the form shows.
import type { KeyboardEvent, ReactNode } from "react";
import { Button } from "../../../primitives/button.tsx";
import { Input } from "../../../primitives/input.tsx";
import { Textarea } from "../../../primitives/textarea.tsx";

export function RewordDialogView({
  hash,
  form,
}: {
  hash: string;
  // The form (RewordFormView), once the commit's message is read.
  form: ReactNode;
}) {
  return (
    <div className="p-5">
      <h2 className="text-base font-semibold">
        Reword <span className="font-mono">{hash}</span>
      </h2>
      {form || <div className="mt-4 h-40" />}
    </div>
  );
}

export function RewordFormView({
  summary,
  onSummaryChange,
  description,
  onDescriptionChange,
  canSave,
  onSave,
  onCancel,
}: {
  summary: string;
  onSummaryChange: (summary: string) => void;
  description: string;
  onDescriptionChange: (description: string) => void;
  canSave: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSave();
    }
  };
  return (
    <div className="mt-4 flex flex-col gap-2">
      <Input
        aria-label="Summary"
        placeholder="Summary (required)"
        value={summary}
        onChange={(e) => onSummaryChange(e.target.value)}
        onKeyDown={onKeyDown}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to edit this field
        autoFocus
      />
      <Textarea
        aria-label="Description"
        placeholder="Description"
        rows={5}
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSave} disabled={!canSave}>
          Reword
        </Button>
      </div>
    </div>
  );
}
